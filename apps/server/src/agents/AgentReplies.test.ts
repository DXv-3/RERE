import { assert, it } from "@effect/vitest";
import {
  AGENT_REPLY_MAX_CHARS,
  MessageId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentReplies from "./AgentReplies.ts";

const asker = ThreadId.make("thread-asker");
const recipient = ThreadId.make("thread-recipient");
const sourceMessage = MessageId.make("message-ask");
const replyMessage = MessageId.make("agent-reply:message-ask");

interface FakeMessage {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: DateTime.Utc;
}

interface Fakes {
  readonly messages: Ref.Ref<ReadonlyArray<FakeMessage>>;
  readonly runs: Ref.Ref<Record<string, OrchestrationV2Run["status"]>>;
  readonly failures: Ref.Ref<Record<string, string>>;
  readonly sent: Ref.Ref<ReadonlyArray<Record<string, unknown>>>;
  readonly askerArchived: Ref.Ref<boolean>;
  /** When set, a send lands in the asker's thread and then the call dies, like a crash before the row is marked. */
  readonly crashAfterSend: Ref.Ref<boolean>;
}

let clock = 0;
const message = (
  id: string,
  threadId: string,
  runId: string | null,
  role: "user" | "assistant",
  text: string,
): FakeMessage => ({
  id,
  threadId,
  runId,
  role,
  text,
  streaming: false,
  createdAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 6, 0, 0, (clock += 1))),
});

const makeLayer = (fakes: Fakes) => {
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.gen(function* () {
        if (threadId !== asker) return null as never;
        const archived = yield* Ref.get(fakes.askerArchived);
        return {
          projectId: "project-1",
          archivedAt: archived ? "2026-10-06T00:00:00.000Z" : null,
        } as never;
      }),
    getThreadRecords: (threadId, _kinds, filter) =>
      Effect.gen(function* () {
        const all = yield* Ref.get(fakes.messages);
        const runs = yield* Ref.get(fakes.runs);
        const failures = yield* Ref.get(fakes.failures);
        const messageFilter = filter as {
          messageIds?: ReadonlyArray<string>;
          messageRunIds?: ReadonlyArray<string>;
          messageRoles?: ReadonlyArray<string>;
          turnItemRunIds?: ReadonlyArray<string>;
        };
        return {
          messages: all.filter(
            (candidate) =>
              candidate.threadId === threadId &&
              (messageFilter.messageIds === undefined ||
                messageFilter.messageIds.includes(candidate.id)) &&
              (messageFilter.messageRunIds === undefined ||
                (candidate.runId !== null &&
                  messageFilter.messageRunIds.includes(candidate.runId))) &&
              (messageFilter.messageRoles === undefined ||
                messageFilter.messageRoles.includes(candidate.role)),
          ),
          runs: Object.entries(runs).map(([id, status]) => ({ id, status })),
          turnItems: (messageFilter.turnItemRunIds ?? []).flatMap((runId) =>
            failures[runId] === undefined
              ? []
              : [{ type: "error", failure: { message: failures[runId] } }],
          ),
        } as never;
      }),
    sendToThread: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(fakes.sent, (all) => [
          ...all,
          input as unknown as Record<string, unknown>,
        ]);
        yield* Ref.update(fakes.messages, (all) => [
          ...all,
          message(input.messageId, input.threadId, "run-asker", "user", input.text),
        ]);
        if (yield* Ref.get(fakes.crashAfterSend)) {
          return yield* Effect.die("crashed after the reply was queued");
        }
        return {} as never;
      }),
  });
  return AgentReplies.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(threads)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
};

const withHarness = <A, E>(
  body: (
    fakes: Fakes,
  ) => Effect.Effect<A, E, AgentReplies.AgentReplies | SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fakes = {
      messages: yield* Ref.make<ReadonlyArray<FakeMessage>>([
        message("message-ask", recipient, "run-1", "user", "Please check the build."),
      ]),
      runs: yield* Ref.make<Record<string, OrchestrationV2Run["status"]>>({ "run-1": "running" }),
      failures: yield* Ref.make<Record<string, string>>({}),
      sent: yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]),
      askerArchived: yield* Ref.make(false),
      crashAfterSend: yield* Ref.make(false),
    } satisfies Fakes;
    return yield* Effect.scoped(body(fakes).pipe(Effect.provide(makeLayer(fakes))));
  });

const ask = (replies: AgentReplies.AgentReplies["Service"], hops = 1) =>
  replies.request({
    sourceMessageId: sourceMessage,
    recipientThreadId: recipient,
    recipientName: "Beta",
    askerThreadId: asker,
    hops,
  });

const answer = (fakes: Fakes, runId: string, text: string) =>
  Ref.update(fakes.messages, (all) => [
    ...all,
    message(`answer-${runId}`, recipient, runId, "assistant", text),
  ]);

const setStatus = (fakes: Fakes, runId: string, status: OrchestrationV2Run["status"]) =>
  Ref.update(fakes.runs, (all) => ({ ...all, [runId]: status }));

it.effect("delivers the final message once, marked as coming from the recipient", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      assert.isTrue(yield* ask(replies));
      yield* answer(fakes, "run-1", "Working on it.");
      assert.equal(yield* replies.settleRecipient(recipient), 0, "nothing while the run is live");
      yield* answer(fakes, "run-1", "The build is green.");
      yield* setStatus(fakes, "run-1", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 1);
      const [sent] = yield* Ref.get(fakes.sent);
      assert.equal(sent?.threadId, asker);
      assert.equal(sent?.senderThreadId, recipient);
      assert.equal(sent?.messageId, replyMessage);
      assert.equal(sent?.commandId, "agent-reply:message-ask");
      assert.equal(sent?.mode, "queue");
      assert.equal(sent?.createdBy, "agent");
      assert.equal(sent?.text, "Reply from agent Beta:\n\nThe build is green.");
      // A repeated event or sweep finds the row delivered and sends nothing more.
      assert.equal(yield* replies.settleRecipient(recipient), 0);
      assert.equal(yield* replies.sweep, 0);
      assert.equal((yield* Ref.get(fakes.sent)).length, 1);
    }),
  ),
);

it.effect(
  "delivers after a restart: a run that settled while the server was down is swept up",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        const replies = yield* AgentReplies.AgentReplies;
        yield* ask(replies);
        yield* answer(fakes, "run-1", "Finished while you were away.");
        yield* setStatus(fakes, "run-1", "completed");
        assert.equal(yield* replies.sweep, 1, "no event ever arrived for it");
        assert.equal((yield* Ref.get(fakes.sent)).length, 1);
      }),
    ),
);

it.effect("does not send twice when the first attempt died after queueing the reply", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      yield* ask(replies);
      yield* answer(fakes, "run-1", "Done.");
      yield* setStatus(fakes, "run-1", "completed");
      yield* Ref.set(fakes.crashAfterSend, true);
      assert.equal(yield* replies.sweep, 0, "the crash left the row pending");
      yield* Ref.set(fakes.crashAfterSend, false);
      assert.equal(yield* replies.sweep, 1, "the retry only marks it delivered");
      assert.equal((yield* Ref.get(fakes.sent)).length, 1, "the reply was queued once");
      assert.equal(yield* replies.sweep, 0);
    }),
  ),
);

it.effect("waits for the queued run that handles the message, not the one that was busy", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      // The recipient was busy in run-1, so the ask sits in the queued run-2.
      yield* Ref.set(fakes.messages, [
        message("message-ask", recipient, "run-2", "user", "Please check the build."),
      ]);
      yield* Ref.set(fakes.runs, { "run-1": "running", "run-2": "queued" });
      yield* ask(replies);
      yield* answer(fakes, "run-1", "Answer to something else.");
      yield* setStatus(fakes, "run-1", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 0);
      yield* setStatus(fakes, "run-2", "running");
      yield* answer(fakes, "run-2", "Here is your answer.");
      yield* setStatus(fakes, "run-2", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 1);
      const [sent] = yield* Ref.get(fakes.sent);
      assert.equal(sent?.text, "Reply from agent Beta:\n\nHere is your answer.");
    }),
  ),
);

it.effect("says the agent could not finish when the run failed, was stopped or was cancelled", () =>
  Effect.gen(function* () {
    const cases = [
      ["failed", "Agent Beta could not finish: its run failed (provider exploded)."],
      ["interrupted", "Agent Beta could not finish: its run was stopped."],
      ["cancelled", "Agent Beta could not finish: its run was cancelled."],
    ] as const;
    for (const [status, expected] of cases) {
      yield* withHarness((fakes) =>
        Effect.gen(function* () {
          const replies = yield* AgentReplies.AgentReplies;
          yield* ask(replies);
          if (status === "failed") {
            yield* Ref.set(fakes.failures, { "run-1": "provider exploded" });
          }
          yield* setStatus(fakes, "run-1", status);
          assert.equal(yield* replies.settleRecipient(recipient), 1);
          const [sent] = yield* Ref.get(fakes.sent);
          assert.equal(sent?.text, expected);
        }),
      );
    }
  }),
);

it.effect("cuts a long reply at the bound and points at the thread", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      yield* ask(replies);
      yield* answer(fakes, "run-1", "x".repeat(AGENT_REPLY_MAX_CHARS + 500));
      yield* setStatus(fakes, "run-1", "completed");
      yield* replies.settleRecipient(recipient);
      const [sent] = yield* Ref.get(fakes.sent);
      const text = String(sent?.text);
      assert.isBelow(text.length, AGENT_REPLY_MAX_CHARS + 300);
      assert.equal(text.split("x").length - 1, AGENT_REPLY_MAX_CHARS);
      assert.include(text, "t3_thread_read");
      assert.include(text, recipient);
    }),
  ),
);

it.effect("never asks for a reply to its own reply, and keeps the depth for the loop guard", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      const sql = yield* SqlClient.SqlClient;
      yield* ask(replies, 2);
      yield* answer(fakes, "run-1", "Done.");
      yield* setStatus(fakes, "run-1", "completed");
      yield* replies.settleRecipient(recipient);
      const rows = yield* sql<{
        readonly status: string;
      }>`SELECT status FROM workbench_agent_replies`;
      assert.deepEqual(rows, [{ status: "delivered" }], "the reply registered no new request");
      assert.equal(yield* replies.hopsOfReply(replyMessage), 2);
      assert.isNull(yield* replies.hopsOfReply("message-ask"));
    }),
  ),
);

it.effect("drops the reply when the asker is archived instead of retrying forever", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      const sql = yield* SqlClient.SqlClient;
      yield* ask(replies);
      yield* Ref.set(fakes.askerArchived, true);
      yield* setStatus(fakes, "run-1", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 0);
      assert.deepEqual(yield* Ref.get(fakes.sent), []);
      const rows = yield* sql<{
        readonly status: string;
      }>`SELECT status FROM workbench_agent_replies`;
      assert.deepEqual(rows, [{ status: "abandoned" }]);
    }),
  ),
);

it.effect("recording the same ask twice keeps one request", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      const sql = yield* SqlClient.SqlClient;
      yield* ask(replies);
      yield* ask(replies);
      const rows = yield* sql<{
        readonly n: number;
      }>`SELECT COUNT(*) AS n FROM workbench_agent_replies`;
      assert.equal(rows[0]?.n, 1);
    }),
  ),
);

it.effect("names a run that was never given a final message", () => {
  assert.include(
    AgentReplies.replyText({
      recipientName: "Beta",
      recipientThreadId: recipient,
      status: "completed",
      finalMessage: null,
      failureDetail: null,
    }),
    "without a written answer",
  );
  return Effect.void;
});

it.effect("carries the next answer to the last asker when the server restarts the recipient", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      const replies = yield* AgentReplies.AgentReplies;
      const sql = yield* SqlClient.SqlClient;
      // The recipient stops to wait for the owner, and that answer goes back as usual.
      assert.isTrue(yield* ask(replies));
      yield* answer(fakes, "run-1", "I need a secret from the owner.");
      yield* setStatus(fakes, "run-1", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 1);

      // The owner answers, so the server's message starts the recipient again.
      const resumed = MessageId.make("agent-secret-provided-message:req-1");
      yield* Ref.update(fakes.messages, (all) => [
        ...all,
        message(resumed, recipient, "run-2", "user", "The owner provided the secret."),
      ]);
      yield* Ref.update(fakes.runs, (all) => ({ ...all, "run-2": "running" as const }));
      yield* AgentReplies.carryReplyToLastAsker(sql, {
        recipientThreadId: recipient,
        sourceMessageId: resumed,
        workMessageId: sourceMessage,
      });
      // Recording it twice, as a repeated answer would, keeps one request.
      yield* AgentReplies.carryReplyToLastAsker(sql, {
        recipientThreadId: recipient,
        sourceMessageId: resumed,
        workMessageId: sourceMessage,
      });
      assert.equal(yield* replies.settleRecipient(recipient), 0, "nothing while it works");

      yield* answer(fakes, "run-2", "Done: the report is ready.");
      yield* setStatus(fakes, "run-2", "completed");
      assert.equal(yield* replies.settleRecipient(recipient), 1);
      const sent = yield* Ref.get(fakes.sent);
      assert.equal(sent.length, 2);
      assert.equal(sent[1]?.threadId, asker);
      assert.equal(sent[1]?.text, "Reply from agent Beta:\n\nDone: the report is ready.");
    }),
  ),
);

it.effect(
  "carries nothing when the work came from a person, not from the agent that asked earlier",
  () =>
    withHarness(() =>
      Effect.gen(function* () {
        const replies = yield* AgentReplies.AgentReplies;
        const sql = yield* SqlClient.SqlClient;
        // An agent asked this recipient something earlier; the current work is a person's message.
        assert.isTrue(yield* ask(replies));
        yield* AgentReplies.carryReplyToLastAsker(sql, {
          recipientThreadId: recipient,
          sourceMessageId: MessageId.make("agent-secret-provided-message:req-2"),
          workMessageId: MessageId.make("message-typed-by-the-owner"),
        });
        const rows = yield* sql`SELECT source_message_id FROM workbench_agent_replies`;
        assert.equal(rows.length, 1, "only the earlier ask");
      }),
    ),
);
