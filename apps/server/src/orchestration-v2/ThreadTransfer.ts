import {
  EventId,
  ThreadId,
  THREAD_TRANSFER_ATTACHMENT_PLACEHOLDER,
  THREAD_TRANSFER_MAX_BYTES,
  THREAD_TRANSFER_MAX_MESSAGES,
  ThreadTransferError,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  type ThreadTransferExport,
  type ThreadTransferExportInput,
  type ThreadTransferImportInput,
  type ThreadTransferImportResult,
  type ThreadTransferMessage,
  type ThreadTransferWorkspace,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as EventSink from "./EventSink.ts";
import { importedMessageEvents } from "./ImportedHistory.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProjectionStoreThreadNotFoundError } from "./ProjectionStore.ts";
import { isForkableSourceRunStatus } from "./ThreadForkService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const TRANSFER_EVENT_PREFIX = "thread-transfer:v1";
const TIMELINE_PAGE_SIZE = 500;
const isThreadNotFound = Schema.is(ProjectionStoreThreadNotFoundError);

/**
 * Hands a thread's visible transcript to another environment (Continue On). The client reads
 * `exportThread` from the source and calls `importThread` on the target; no server talks to
 * another. The import is a new thread of imported history with no turn started, so the first
 * message the user sends there runs the server's existing budgeted context handoff.
 */
export class ThreadTransfer extends Context.Service<
  ThreadTransfer,
  {
    readonly exportThread: (
      input: ThreadTransferExportInput,
    ) => Effect.Effect<ThreadTransferExport, ThreadTransferError>;
    readonly importThread: (
      input: ThreadTransferImportInput,
    ) => Effect.Effect<ThreadTransferImportResult, ThreadTransferError>;
  }
>()("t3/orchestration-v2/ThreadTransfer") {}

const failed = (cause: unknown) => new ThreadTransferError({ reason: "failed", cause });

function transferThreadId(transferId: string): ThreadId {
  return ThreadId.make(`transfer:${transferId}`);
}

/** The transcript text of one item, or null when the item is not part of a transcript. */
function transcriptMessage(item: OrchestrationV2TurnItem): ThreadTransferMessage | null {
  const createdAt = DateTime.formatIso(item.startedAt ?? item.completedAt ?? item.updatedAt);
  switch (item.type) {
    case "user_message": {
      const attachments = item.attachments.map(() => THREAD_TRANSFER_ATTACHMENT_PLACEHOLDER);
      const text = [item.text, ...attachments].filter((part) => part.trim() !== "").join("\n");
      return text === "" ? null : { role: "user", text, createdAt };
    }
    case "assistant_message": {
      const attachments = (item.attachments ?? []).map(
        () => THREAD_TRANSFER_ATTACHMENT_PLACEHOLDER,
      );
      const text = [item.text, ...attachments].filter((part) => part.trim() !== "").join("\n");
      return text === "" ? null : { role: "assistant", text, createdAt };
    }
    case "proposed_plan":
      return item.markdown.trim() === ""
        ? null
        : { role: "assistant", text: `Proposed plan:\n\n${item.markdown}`, createdAt };
    default:
      return null;
  }
}

/**
 * Keeps the newest messages within both limits. The result is always a contiguous suffix, so an
 * oversized message ends the walk instead of being skipped over.
 */
export function capTransferMessages(messages: ReadonlyArray<ThreadTransferMessage>): {
  readonly kept: ReadonlyArray<ThreadTransferMessage>;
  readonly omitted: number;
} {
  let bytes = 0;
  let start = messages.length;
  while (start > 0 && messages.length - start < THREAD_TRANSFER_MAX_MESSAGES) {
    const size = Buffer.byteLength(messages[start - 1]!.text);
    if (bytes + size > THREAD_TRANSFER_MAX_BYTES) break;
    bytes += size;
    start -= 1;
  }
  return { kept: messages.slice(start), omitted: start };
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const eventSink = yield* EventSink.EventSinkV2;

  const readWorkspace = Effect.fn("ThreadTransfer.readWorkspace")(function* (cwd: string) {
    const status = yield* git.status({ cwd }).pipe(Effect.option);
    if (Option.isNone(status) || !status.value.isRepo) {
      return {
        cwd,
        isRepo: false,
        branch: null,
        isDefaultBranch: false,
        headSha: null,
        hasWorkingTreeChanges: false,
        changedFiles: [],
        hasUpstream: false,
        aheadCount: 0,
      } satisfies ThreadTransferWorkspace;
    }
    const head = yield* git
      .execute({
        operation: "ThreadTransfer.readWorkspace.head",
        cwd,
        args: ["rev-parse", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      })
      .pipe(Effect.option);
    const headSha =
      Option.isSome(head) && head.value.exitCode === 0 && head.value.stdout.trim() !== ""
        ? head.value.stdout.trim()
        : null;
    return {
      cwd,
      isRepo: true,
      branch: status.value.refName,
      isDefaultBranch: status.value.isDefaultRef,
      headSha,
      hasWorkingTreeChanges: status.value.hasWorkingTreeChanges,
      changedFiles: status.value.workingTree.files.map((file) => file.path),
      hasUpstream: status.value.hasUpstream,
      aheadCount: status.value.aheadCount,
    } satisfies ThreadTransferWorkspace;
  });

  /** The thread's visible transcript, including history inherited from a fork parent. */
  const readMessages = Effect.fn("ThreadTransfer.readMessages")(function* (threadId: ThreadId) {
    const messages: Array<ThreadTransferMessage> = [];
    let afterPosition: number | undefined;
    for (;;) {
      const page = yield* threads.getTimelinePage(threadId, {
        view: "messages",
        limit: TIMELINE_PAGE_SIZE,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      for (const projected of page.items) {
        const message = transcriptMessage(projected.item);
        if (message !== null) messages.push(message);
      }
      const last = page.items.at(-1);
      if (!page.hasMore || last === undefined) return messages;
      afterPosition = last.position;
    }
  });

  const exportThread: ThreadTransfer["Service"]["exportThread"] = Effect.fn(
    "ThreadTransfer.exportThread",
  )(function* (input) {
    yield* threads.ensureLegacyTranscript(input.threadId).pipe(Effect.mapError(failed));
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(
        Effect.mapError((error) =>
          isThreadNotFound(error.cause)
            ? new ThreadTransferError({ reason: "thread_not_found" })
            : failed(error),
        ),
      );
    if (
      records.runs.some(
        (run) => run.status !== "rolled_back" && !isForkableSourceRunStatus(run.status),
      )
    ) {
      return yield* new ThreadTransferError({ reason: "run_in_progress" });
    }
    const thread = records.thread;
    const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) {
      return yield* new ThreadTransferError({ reason: "project_not_found" });
    }
    const transcript = yield* readMessages(input.threadId).pipe(Effect.mapError(failed));
    const messages = transcript.slice(input.afterCount ?? 0);
    const repositoryIdentity = yield* repositoryIdentities.resolve(project.value.workspaceRoot);
    const workspace = yield* readWorkspace(thread.worktreePath ?? project.value.workspaceRoot);
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      repositoryIdentity,
      messages,
      messageCount: transcript.length,
      workspace,
    } satisfies ThreadTransferExport;
  });

  const importThread: ThreadTransfer["Service"]["importThread"] = Effect.fn(
    "ThreadTransfer.importThread",
  )(function* (input) {
    const threadId = transferThreadId(input.transferId);
    const { kept, omitted: omittedByLimit } = capTransferMessages(input.messages);

    const existing = yield* threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        isThreadNotFound(error.cause) ? Effect.succeed(Option.none()) : Effect.fail(failed(error)),
      ),
    );
    if (Option.isSome(existing)) {
      const stored = yield* readMessages(threadId).pipe(Effect.mapError(failed));
      const unchanged = {
        threadId,
        alreadyImported: true,
        importedMessageCount: kept.length,
        omittedMessageCount: omittedByLimit,
        messageCount: stored.length,
      };
      if (input.appendFrom === undefined) return unchanged;
      // A copy that has run turns of its own is a conversation in its own right now.
      const appendable =
        existing.value.runs.length === 0 &&
        stored.length === input.appendFrom &&
        omittedByLimit === 0 &&
        stored.length + kept.length < THREAD_TRANSFER_MAX_MESSAGES;
      if (!appendable) return { ...unchanged, appendable: false };
      const at = DateTime.formatIso(yield* DateTime.now);
      const added: ReadonlyArray<ThreadTransferMessage> = [
        ...kept.map((message) => ({
          ...message,
          createdAt: Option.isSome(DateTime.make(message.createdAt)) ? message.createdAt : at,
        })),
        ...(input.note.trim() === ""
          ? []
          : [{ role: "assistant" as const, text: input.note.trim(), createdAt: at }]),
      ];
      if (added.length > 0) {
        yield* eventSink
          .write({
            events: added.flatMap((message, offset) =>
              importedMessageEvents({
                eventPrefix: TRANSFER_EVENT_PREFIX,
                threadId,
                index: stored.length + offset,
                message,
              }),
            ),
          })
          .pipe(Effect.mapError(failed));
      }
      return { ...unchanged, messageCount: stored.length + added.length, appendable: true };
    }

    const project = yield* projects.get(input.projectId).pipe(Effect.mapError(failed));
    if (Option.isNone(project)) {
      return yield* new ThreadTransferError({ reason: "project_not_found" });
    }

    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const omittedNote =
      omittedByLimit === 0
        ? ""
        : `\n\n${omittedByLimit} earlier message${omittedByLimit === 1 ? " was" : "s were"} left out because the conversation was too long to carry over.`;
    const transcript: ReadonlyArray<ThreadTransferMessage> = [
      ...kept.map((message) => ({
        ...message,
        createdAt: Option.isSome(DateTime.make(message.createdAt)) ? message.createdAt : nowIso,
      })),
      // The context budget always tries the final assistant message, so the note reaches the model.
      ...(`${input.note.trim()}${omittedNote}` === ""
        ? []
        : [
            {
              role: "assistant" as const,
              text: `${input.note.trim()}${omittedNote}`,
              createdAt: nowIso,
            },
          ]),
    ];
    const title = input.title.trim() === "" ? "Untitled thread" : input.title.trim();
    const appThread: OrchestrationV2AppThread = {
      createdBy: "system",
      creationSource: "server",
      id: threadId,
      projectId: input.projectId,
      title,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: null,
      historyOrigin: "v1_import",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    // One write keeps the import atomic: a retry that finds the thread can trust it is complete.
    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${TRANSFER_EVENT_PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId: appThread.providerInstanceId,
            occurredAt: now,
            payload: appThread,
          },
          ...transcript.flatMap((message, index) =>
            importedMessageEvents({
              eventPrefix: TRANSFER_EVENT_PREFIX,
              threadId,
              index,
              message,
            }),
          ),
        ],
      })
      .pipe(Effect.mapError(failed));

    return {
      threadId,
      alreadyImported: false,
      importedMessageCount: kept.length,
      omittedMessageCount: omittedByLimit,
      messageCount: transcript.length,
      appendable: true,
    };
  });

  return ThreadTransfer.of({ exportThread, importThread });
});

export const layer = Layer.effect(ThreadTransfer, make);
