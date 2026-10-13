import {
  AGENT_REPLY_MAX_CHARS,
  AGENT_REPLY_MESSAGE_ID_PREFIX,
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

/** A reply nobody could deliver in this long is dropped, so a gone thread does not retry forever. */
const PENDING_REPLY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL = "1 minute";
const FAILURE_DETAIL_MAX_CHARS = 300;

export interface AgentReplyRequest {
  /** The agent-to-agent message that asked for an answer; it lives in the recipient's thread. */
  readonly sourceMessageId: MessageId;
  readonly recipientThreadId: ThreadId;
  readonly recipientName: string;
  readonly askerThreadId: ThreadId;
  /** How many agent messages deep the recipient's run is, so the reply keeps the loop guard honest. */
  readonly hops: number;
}

interface ReplyRow {
  readonly source_message_id: string;
  readonly recipient_thread_id: string;
  readonly recipient_name: string;
  readonly asker_thread_id: string;
  readonly hops: number;
  readonly created_at: string;
}

const agentReplyMessageId = (sourceMessageId: MessageId) =>
  MessageId.make(`${AGENT_REPLY_MESSAGE_ID_PREFIX}${sourceMessageId}`);

export const isAgentReplyMessageId = (messageId: string) =>
  messageId.startsWith(AGENT_REPLY_MESSAGE_ID_PREFIX);

/**
 * The text an asker receives for a settled run. A run that did not complete says so instead of
 * leaving the asker waiting; a long answer is cut and points at the thread for the rest.
 */
export function replyText(input: {
  readonly recipientName: string;
  readonly recipientThreadId: ThreadId;
  readonly status: OrchestrationV2Run["status"];
  readonly finalMessage: string | null;
  readonly failureDetail: string | null;
}): string {
  if (input.status !== "completed") {
    const reason =
      input.status === "failed"
        ? `its run failed${input.failureDetail === null ? "" : ` (${input.failureDetail})`}`
        : input.status === "rolled_back"
          ? "its run was rolled back"
          : input.status === "cancelled"
            ? "its run was cancelled"
            : "its run was stopped";
    return `Agent ${input.recipientName} could not finish: ${reason}.`;
  }
  const body = input.finalMessage ?? "";
  if (body.length === 0) {
    return `Reply from agent ${input.recipientName}: it finished without a written answer. Read thread ${input.recipientThreadId} with t3_thread_read to see what it did.`;
  }
  const shown =
    body.length > AGENT_REPLY_MAX_CHARS
      ? `${body.slice(0, AGENT_REPLY_MAX_CHARS)}\n\n[Reply cut at ${AGENT_REPLY_MAX_CHARS} characters. Read the rest with t3_thread_read on thread ${input.recipientThreadId}.]`
      : body;
  return `Reply from agent ${input.recipientName}:\n\n${shown}`;
}

/**
 * Asks for the recipient's next answer on behalf of whoever asked it last. Used when the server,
 * not the asker, restarts the recipient: an agent that stopped to wait for the owner (a secret,
 * for one) carries on when the owner answers, and the agent that gave it the work would otherwise
 * never hear the result and sit waiting until a person typed "continue".
 *
 * `sourceMessageId` is the server's message in the recipient's thread. `workMessageId` is the
 * message the recipient was working on when it stopped: the answer is carried only when an agent
 * sent that message and wanted a reply, so work a person asked for directly never reports to an
 * agent that happened to ask something earlier.
 */
export const carryReplyToLastAsker = (
  sql: SqlClient.SqlClient,
  input: {
    readonly recipientThreadId: ThreadId;
    readonly sourceMessageId: MessageId;
    readonly workMessageId: MessageId;
  },
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO workbench_agent_replies
        (source_message_id, recipient_thread_id, recipient_name, asker_thread_id, hops, status, created_at)
      SELECT ${input.sourceMessageId}, recipient_thread_id, recipient_name, asker_thread_id, hops,
             'pending', ${now}
      FROM workbench_agent_replies
      WHERE recipient_thread_id = ${input.recipientThreadId}
        AND source_message_id = ${input.workMessageId}
      ON CONFLICT(source_message_id) DO NOTHING
    `;
  });

/**
 * Carries an agent's answer back to the agent that asked. `agent_send` records a pending row when
 * it asks for a reply; when the run that handled the message settles, the final message is
 * delivered to the asker's thread under an id derived from the source message. The row is the
 * durable state: a restart, or a run that settled while the server was down, is picked up by the
 * sweep, and a second delivery attempt finds the same message id and does nothing.
 */
export class AgentReplies extends Context.Service<
  AgentReplies,
  {
    /** Records that the asker wants the answer. False when it could not be recorded. */
    readonly request: (input: AgentReplyRequest) => Effect.Effect<boolean>;
    /** Depth recorded for an automatic reply message, so the loop guard can follow it. */
    readonly hopsOfReply: (messageId: string) => Effect.Effect<number | null>;
    /** Delivers every pending reply for the recipient whose run has settled. Returns how many. */
    readonly settleRecipient: (threadId: ThreadId) => Effect.Effect<number>;
    /** Same, for every recipient. Runs at startup and on a timer. */
    readonly sweep: Effect.Effect<number>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agents/AgentReplies") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // One delivery at a time: the event stream and the sweep can reach the same row together.
  const lock = yield* Semaphore.make(1);

  const iso = Effect.map(DateTime.now, DateTime.formatIso);

  const request: AgentReplies["Service"]["request"] = (input) =>
    Effect.gen(function* () {
      const now = yield* iso;
      yield* sql`
        INSERT INTO workbench_agent_replies
          (source_message_id, recipient_thread_id, recipient_name, asker_thread_id, hops, status, created_at)
        VALUES
          (${input.sourceMessageId}, ${input.recipientThreadId}, ${input.recipientName},
           ${input.askerThreadId}, ${input.hops}, 'pending', ${now})
        ON CONFLICT(source_message_id) DO NOTHING
      `;
      return true;
    }).pipe(
      Effect.orDie,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not record that an agent message wants a reply", {
              sourceMessageId: input.sourceMessageId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );

  const hopsOfReply: AgentReplies["Service"]["hopsOfReply"] = (messageId) =>
    isAgentReplyMessageId(messageId)
      ? sql<{ readonly hops: number }>`
          SELECT hops FROM workbench_agent_replies
          WHERE source_message_id = ${messageId.slice(AGENT_REPLY_MESSAGE_ID_PREFIX.length)}
        `.pipe(
          Effect.map((rows) => rows[0]?.hops ?? null),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(null);

  const finish = (row: ReplyRow, status: "delivered" | "abandoned") =>
    Effect.gen(function* () {
      const now = yield* iso;
      yield* sql`
        UPDATE workbench_agent_replies SET status = ${status}, settled_at = ${now}
        WHERE source_message_id = ${row.source_message_id} AND status = 'pending'
      `;
    });

  const readOutcome = (threadId: ThreadId, run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (run.status !== "completed") {
        const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [run.id],
          turnItemTypes: ["error"],
        });
        const failure = turnItems.findLast((item) => item.type === "error");
        const detail =
          failure?.type === "error"
            ? failure.failure.message.trim().slice(0, FAILURE_DETAIL_MAX_CHARS)
            : "";
        return { finalMessage: null, failureDetail: detail.length > 0 ? detail : null };
      }
      const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRunIds: [run.id],
        messageRoles: ["assistant"],
      });
      const finalMessage = messages
        .filter((message) => message.runId === run.id && !message.streaming)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        )
        .map((message) => assistantCitationsToPlainText(message.text).trim())
        .findLast((text) => text.length > 0);
      return { finalMessage: finalMessage ?? null, failureDetail: null };
    });

  /** True when the row reached an end state (delivered or dropped) on this call. */
  const settleRow = (row: ReplyRow) =>
    Effect.gen(function* () {
      const sourceMessageId = MessageId.make(row.source_message_id);
      const recipientThreadId = ThreadId.make(row.recipient_thread_id);
      const askerThreadId = ThreadId.make(row.asker_thread_id);

      const source = yield* threads.getThreadRecords(recipientThreadId, ["runs", "messages"], {
        messageIds: [sourceMessageId],
      });
      const message = source.messages.find((candidate) => candidate.id === sourceMessageId);
      if (message === undefined) {
        yield* finish(row, "abandoned");
        return false;
      }
      // The run that consumed the message, which is the queued run when the recipient was busy.
      const run =
        message.runId === null
          ? undefined
          : source.runs.find((candidate) => candidate.id === message.runId);
      if (run === undefined || !ThreadManagementService.isTerminalRunStatus(run.status)) {
        return false;
      }

      const asker = yield* threads
        .getThreadShell(askerThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (asker === null || asker.archivedAt !== null) {
        yield* finish(row, "abandoned");
        return false;
      }

      const replyId = agentReplyMessageId(sourceMessageId);
      const already = yield* threads.getThreadRecords(askerThreadId, ["messages"], {
        messageIds: [replyId],
      });
      if (!already.messages.some((candidate) => candidate.id === replyId)) {
        const outcome = yield* readOutcome(recipientThreadId, run);
        yield* threads.sendToThread({
          projectId: asker.projectId,
          // Deterministic ids: delivering the same reply twice queues it once.
          commandId: CommandId.make(`${AGENT_REPLY_MESSAGE_ID_PREFIX}${row.source_message_id}`),
          threadId: askerThreadId,
          senderThreadId: recipientThreadId,
          messageId: replyId,
          text: replyText({
            recipientName: row.recipient_name,
            recipientThreadId,
            status: run.status,
            ...outcome,
          }),
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        });
      }
      yield* finish(row, "delivered");
      return true;
    });

  const settleRows = (rows: ReadonlyArray<ReplyRow>) =>
    lock.withPermit(
      Effect.gen(function* () {
        let delivered = 0;
        for (const row of rows) {
          // A row another caller finished while this one waited for the lock is not read again.
          const current = yield* sql<{ readonly status: string }>`
            SELECT status FROM workbench_agent_replies WHERE source_message_id = ${row.source_message_id}
          `;
          if (current[0]?.status !== "pending") continue;
          const done = yield* settleRow(row).pipe(
            Effect.orDie,
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("could not deliver an agent reply yet", {
                    sourceMessageId: row.source_message_id,
                    cause: Cause.pretty(cause),
                  }).pipe(Effect.as(false)),
            ),
          );
          if (done) delivered += 1;
        }
        return delivered;
      }),
    );

  const quietly = <A, E>(effect: Effect.Effect<A, E>, fallback: A) =>
    effect.pipe(
      Effect.orDie,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("agent reply delivery failed", { cause: Cause.pretty(cause) }).pipe(
              Effect.as(fallback),
            ),
      ),
    );

  const settleRecipient: AgentReplies["Service"]["settleRecipient"] = (threadId) =>
    quietly(
      Effect.gen(function* () {
        const rows = yield* sql<ReplyRow>`
          SELECT * FROM workbench_agent_replies
          WHERE recipient_thread_id = ${threadId} AND status = 'pending'
          ORDER BY created_at
        `;
        return yield* settleRows(rows);
      }),
      0,
    );

  const sweep: AgentReplies["Service"]["sweep"] = quietly(
    Effect.gen(function* () {
      const cutoff = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { milliseconds: PENDING_REPLY_TTL_MS }),
      );
      yield* sql`
        UPDATE workbench_agent_replies SET status = 'abandoned', settled_at = ${yield* iso}
        WHERE status = 'pending' AND created_at <= ${cutoff}
      `;
      const rows = yield* sql<ReplyRow>`
        SELECT * FROM workbench_agent_replies WHERE status = 'pending' ORDER BY created_at
      `;
      return yield* settleRows(rows);
    }),
    0,
  );

  const handleEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" &&
    ThreadManagementService.isTerminalRunStatus(event.payload.status)
      ? settleRecipient(event.payload.threadId)
      : Effect.succeed(0);

  const start: AgentReplies["Service"]["start"] = Effect.fn("AgentReplies.start")(function* () {
    yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid));
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, handleEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("agent reply watcher stopped", { cause: Cause.pretty(cause) }),
        ),
      ),
    );
  });

  return AgentReplies.of({ request, hopsOfReply, settleRecipient, sweep, start });
});

export const layer = Layer.effect(AgentReplies, make);
