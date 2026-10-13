import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  THREAD_TRANSFER_MAX_BYTES,
  THREAD_TRANSFER_MAX_MESSAGES,
  ThreadTransferError,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type ThreadTransferImportInput,
  type ThreadTransferMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTransfer from "./ThreadTransfer.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const TOOL_OUTPUT_MARKER = "TOOL_OUTPUT_MARKER";
const REPLY_TEXT = "assistant reply text";

interface CapturedTurn {
  readonly threadId: ThreadId;
  readonly text: string;
}

const unimplemented = (detail: string) =>
  Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));

/**
 * A codex adapter that records the text each turn starts with. A completing turn emits one tool
 * item and one assistant reply; a held turn never finishes, leaving its run in progress.
 */
const makeAdapter = (input: {
  readonly captured: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly hold: boolean;
}) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.captured, (turns) => [
                ...turns,
                { threadId: turnInput.threadId, text: turnInput.message.text },
              ]);
              if (input.hold) return;
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const itemBase = {
                threadId: turnInput.threadId,
                runId: turnInput.runId,
                nodeId: turnInput.rootNodeId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                nativeItemRef: null,
                parentItemId: null,
                status: "completed" as const,
                title: null,
                startedAt: eventTime,
                completedAt: eventTime,
                updatedAt: eventTime,
              };
              yield* PubSub.publishAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...itemBase,
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:cmd`,
                    ),
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    type: "command_execution",
                    input: "ls",
                    output: TOOL_OUTPUT_MARKER,
                    exitCode: 0,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...itemBase,
                    id: TurnItemId.make(
                      `turn-item:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    ordinal: turnInput.runOrdinal * 100 + 2,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: REPLY_TEXT,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unimplemented("readThreadSnapshot unused"),
          rollbackThread: () => unimplemented("rollbackThread unused"),
          forkThread: () => unimplemented("forkThread unused"),
        };
      }),
  }) satisfies ProviderAdapterV2Shape;

/** The orchestrator stack, the legacy importer, the transfer service, and real Git. */
const makeTestLayer = (input: {
  readonly name: string;
  readonly workspace: string;
  readonly adapter: ProviderAdapterV2Shape;
}) => {
  const databaseLayer = SqlitePersistenceMemory;
  const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: input.name,
      runtimePolicyOverride: {
        cwd: input.workspace,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    ProviderAdapterRegistry.makeSingleLayer(input.adapter),
    { databaseLayer },
  );
  const projectStoreLayer = ProjectStore.layer.pipe(Layer.provide(databaseLayer));
  const base = Layer.mergeAll(orchestratorLayer, databaseLayer, projectStoreLayer);
  const legacyImporterLayer = LegacyV1ThreadImporter.layer.pipe(Layer.provide(base));
  const threadManagementLayer = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(Layer.merge(base, legacyImporterLayer)),
  );
  const gitLayer = GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-transfer-" })),
    Layer.provide(VcsProcess.layer),
  );
  const transferLayer = ThreadTransfer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(base, threadManagementLayer, gitLayer, RepositoryIdentityResolver.layer),
    ),
  );
  return Layer.mergeAll(base, gitLayer, threadManagementLayer, transferLayer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
};

const registerProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event:${projectId}:created`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-03-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Transfer project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    });
  });

/** Dispatches one message and, unless the turn is held, waits until its run completes. */
const sendMessage = (threadId: ThreadId, text: string, options: { readonly wait: boolean }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const completed = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "run.updated" && event.payload.status === "completed",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
    if (!options.wait) return yield* Fiber.interrupt(completed);
    yield* worker.drain();
    yield* Fiber.join(completed);
    yield* worker.drain();
  });

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:create`),
      threadId,
      projectId,
      title: "Source thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

const importInput = (
  overrides: Partial<ThreadTransferImportInput> & Pick<ThreadTransferImportInput, "projectId">,
): ThreadTransferImportInput => ({
  transferId: "transfer-one",
  title: "Handed over",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  messages: [],
  note: "Handed over from another machine.",
  ...overrides,
});

const message = (
  role: ThreadTransferMessage["role"],
  text: string,
  minute: number,
): ThreadTransferMessage => ({
  role,
  text,
  createdAt: `2026-03-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driverService = yield* GitVcsDriver.GitVcsDriver;
    return yield* driverService.execute({
      operation: "ThreadTransfer.test.git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
  });

describe("ThreadTransfer", () => {
  it.live("exports the visible transcript without tool items and reports the git state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-transfer-export");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const transfer = yield* ThreadTransfer.ThreadTransfer;
          const projectId = ProjectId.make("project:transfer-export");
          const threadId = ThreadId.make("thread:transfer-export");
          yield* registerProject(projectId, workspace);
          yield* createThread(threadId, projectId);
          yield* sendMessage(threadId, "please list the files", { wait: true });

          // A pushed branch: a bare remote that the checkout tracks.
          const remote = yield* fs.makeTempDirectory({ prefix: "t3-transfer-remote-" });
          yield* git(remote, "init", "--bare");
          yield* git(workspace, "remote", "add", "origin", remote);
          // Off the default branch, and past any global push hook on the machine running the tests.
          yield* git(workspace, "checkout", "-b", "feature/transfer");
          yield* git(workspace, "-c", "core.hooksPath=/dev/null", "push", "-u", "origin", "HEAD");

          const clean = yield* transfer.exportThread({ threadId });
          assert.deepStrictEqual(
            clean.messages.map((entry) => [entry.role, entry.text]),
            [
              ["user", "please list the files"],
              ["assistant", REPLY_TEXT],
            ],
          );
          assert.isFalse(clean.messages.some((entry) => entry.text.includes(TOOL_OUTPUT_MARKER)));
          assert.equal(clean.title, "Source thread");
          assert.deepStrictEqual(clean.modelSelection, modelSelection);
          assert.isTrue(clean.workspace.isRepo);
          assert.match(clean.workspace.headSha ?? "", /^[0-9a-f]{40}$/);
          assert.equal(clean.workspace.branch, "feature/transfer");
          assert.isFalse(clean.workspace.isDefaultBranch);
          assert.isFalse(clean.workspace.hasWorkingTreeChanges);
          assert.deepStrictEqual(clean.workspace.changedFiles, []);
          assert.isTrue(clean.workspace.hasUpstream);
          assert.equal(clean.workspace.aheadCount, 0);

          // One commit that was never pushed, and one file that was never committed.
          yield* fs.writeFileString(path.join(workspace, "committed.txt"), "committed\n");
          yield* git(workspace, "add", "committed.txt");
          yield* git(workspace, "commit", "-m", "unpushed");
          yield* fs.writeFileString(path.join(workspace, "dirty.txt"), "dirty\n");

          const dirty = yield* transfer.exportThread({ threadId });
          assert.isTrue(dirty.workspace.hasWorkingTreeChanges);
          assert.deepStrictEqual(dirty.workspace.changedFiles, ["dirty.txt"]);
          assert.isTrue(dirty.workspace.hasUpstream);
          assert.equal(dirty.workspace.aheadCount, 1);
          assert.notEqual(dirty.workspace.headSha, clean.workspace.headSha);
        }).pipe(
          Effect.provide(
            makeTestLayer({
              name: "thread-transfer-export",
              workspace,
              adapter: makeAdapter({ captured, hold: false }),
            }),
          ),
        );
      }),
    ),
  );

  it.live("refuses to export a thread whose run is still in progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-transfer-running");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const transfer = yield* ThreadTransfer.ThreadTransfer;
          const projectId = ProjectId.make("project:transfer-running");
          const threadId = ThreadId.make("thread:transfer-running");
          yield* registerProject(projectId, workspace);
          yield* createThread(threadId, projectId);
          yield* sendMessage(threadId, "keep working", { wait: false });

          const result = yield* Effect.result(transfer.exportThread({ threadId }));
          assert.isTrue(Result.isFailure(result));
          assert.instanceOf(
            Result.getOrElse(Result.flip(result), () => null),
            ThreadTransferError,
          );
          assert.equal(Result.isFailure(result) ? result.failure.reason : null, "run_in_progress");

          const missing = yield* Effect.result(
            transfer.exportThread({ threadId: ThreadId.make("thread:transfer-missing") }),
          );
          assert.equal(
            Result.isFailure(missing) ? missing.failure.reason : null,
            "thread_not_found",
          );
        }).pipe(
          Effect.provide(
            makeTestLayer({
              name: "thread-transfer-running",
              workspace,
              adapter: makeAdapter({ captured, hold: true }),
            }),
          ),
        );
      }),
    ),
  );

  it.live("extends a copied thread until it has turns of its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-transfer-append");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const transfer = yield* ThreadTransfer.ThreadTransfer;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const projectId = ProjectId.make("project:transfer-append");
          yield* registerProject(projectId, workspace);
          const created = yield* transfer.importThread(
            importInput({
              projectId,
              transferId: "transfer-append",
              messages: [message("user", "one", 1), message("assistant", "two", 2)],
              note: "NOTE",
              appendFrom: 0,
            }),
          );
          assert.equal(created.messageCount, 3);

          const more = importInput({
            projectId,
            transferId: "transfer-append",
            messages: [message("user", "three", 3), message("assistant", "four", 4)],
            note: "",
            appendFrom: 3,
          });
          const appended = yield* transfer.importThread(more);
          assert.isTrue(appended.appendable);
          assert.equal(appended.messageCount, 5);
          // A retry no longer matches the stored count, so it writes nothing.
          const retry = yield* transfer.importThread(more);
          assert.isFalse(retry.appendable);
          assert.equal(retry.messageCount, 5);

          const records = yield* threads.getThreadRecords(created.threadId, ["messages"]);
          assert.deepStrictEqual(
            records.messages.map((entry) => entry.text),
            ["one", "two", "NOTE", "three", "four"],
          );

          const exported = yield* transfer.exportThread({
            threadId: created.threadId,
            afterCount: 3,
          });
          assert.equal(exported.messageCount, 5);
          assert.deepStrictEqual(
            exported.messages.map((entry) => entry.text),
            ["three", "four"],
          );

          yield* sendMessage(created.threadId, "a reply written here", { wait: true });
          const afterTurn = yield* transfer.importThread(
            importInput({
              projectId,
              transferId: "transfer-append",
              messages: [message("user", "five", 5)],
              note: "",
              appendFrom: 5,
            }),
          );
          assert.isFalse(afterTurn.appendable);
        }).pipe(
          Effect.provide(
            makeTestLayer({
              name: "thread-transfer-append",
              workspace,
              adapter: makeAdapter({ captured, hold: false }),
            }),
          ),
        );
      }),
    ),
  );

  it.live("imports once per transfer id and stores a run-less thread with the note last", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-transfer-import");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const transfer = yield* ThreadTransfer.ThreadTransfer;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const projectId = ProjectId.make("project:transfer-import");
          yield* registerProject(projectId, workspace);
          const input = importInput({
            projectId,
            messages: [
              message("user", "first question", 1),
              message("assistant", "first answer", 2),
            ],
            note: "NOTE: continue on the new machine.",
          });

          const first = yield* transfer.importThread(input);
          assert.equal(first.threadId, "transfer:transfer-one");
          assert.isFalse(first.alreadyImported);
          assert.equal(first.importedMessageCount, 2);
          assert.equal(first.omittedMessageCount, 0);

          const retry = yield* transfer.importThread(input);
          assert.equal(retry.threadId, first.threadId);
          assert.isTrue(retry.alreadyImported);

          const records = yield* threads.getThreadRecords(first.threadId, [
            "messages",
            "runs",
            "providerThreads",
          ]);
          assert.equal(records.thread.historyOrigin, "v1_import");
          assert.equal(records.thread.projectId, projectId);
          assert.equal(records.thread.title, "Handed over");
          assert.isNull(records.thread.activeProviderThreadId);
          assert.isEmpty(records.runs);
          assert.isEmpty(records.providerThreads);
          // The retry wrote nothing: two transcript messages plus the note, once.
          assert.deepStrictEqual(
            records.messages.map((entry) => [entry.role, entry.text]),
            [
              ["user", "first question"],
              ["assistant", "first answer"],
              ["assistant", "NOTE: continue on the new machine."],
            ],
          );
          assert.isEmpty(yield* Ref.get(captured));

          const unknownProject = yield* Effect.result(
            transfer.importThread(
              importInput({
                projectId: ProjectId.make("project:does-not-exist"),
                transferId: "transfer-two",
              }),
            ),
          );
          assert.equal(
            Result.isFailure(unknownProject) ? unknownProject.failure.reason : null,
            "project_not_found",
          );
        }).pipe(
          Effect.provide(
            makeTestLayer({
              name: "thread-transfer-import",
              workspace,
              adapter: makeAdapter({ captured, hold: false }),
            }),
          ),
        );
      }),
    ),
  );

  it.live(
    "the first message on an imported thread hands the history and the note to the model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspace = yield* checkpointWorkspace("thread-transfer-handoff");
          const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          yield* Effect.gen(function* () {
            const transfer = yield* ThreadTransfer.ThreadTransfer;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const projectId = ProjectId.make("project:transfer-handoff");
            yield* registerProject(projectId, workspace);
            const imported = yield* transfer.importThread(
              importInput({
                projectId,
                messages: [
                  message("user", "EARLIER_USER_MARKER", 1),
                  message("assistant", "EARLIER_ASSISTANT_MARKER", 2),
                ],
                note: "NOTE_MARKER: fetch branch feature/x at commit abc123.",
              }),
            );

            yield* sendMessage(imported.threadId, "carry on", { wait: true });

            const projection = yield* orchestrator.getThreadProjection(imported.threadId);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.equal(projection.contextHandoffs.length, 1);
            const handoff = projection.contextHandoffs[0]!;
            assert.equal(handoff.strategy, "manual_context");
            assert.include(handoff.summaryText, "NOTE_MARKER");
            assert.include(handoff.summaryText, "EARLIER_USER_MARKER");
            assert.include(handoff.summaryText, "Earlier conversation history carried over");
            assert.notInclude(handoff.summaryText, "previous CodeWrench orchestrator");

            const turns = yield* Ref.get(captured);
            assert.equal(turns.length, 1);
            assert.include(turns[0]!.text, "Context handoff (manual_context):");
            assert.include(turns[0]!.text, "NOTE_MARKER");
            assert.include(turns[0]!.text, "User message:\ncarry on");
          }).pipe(
            Effect.provide(
              makeTestLayer({
                name: "thread-transfer-handoff",
                workspace,
                adapter: makeAdapter({ captured, hold: false }),
              }),
            ),
          );
        }),
      ),
  );

  it.live("keeps the newest messages within the byte limit and says how many were left out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* checkpointWorkspace("thread-transfer-cap");
        const captured = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        yield* Effect.gen(function* () {
          const transfer = yield* ThreadTransfer.ThreadTransfer;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const projectId = ProjectId.make("project:transfer-cap");
          yield* registerProject(projectId, workspace);
          const big = (marker: string) => `${marker} ${"x".repeat(4 * 1024 * 1024)}`;
          const result = yield* transfer.importThread(
            importInput({
              projectId,
              messages: [
                message("user", big("OLDEST"), 1),
                message("assistant", big("MIDDLE"), 2),
                message("user", big("NEWEST"), 3),
              ],
              note: "Handed over.",
            }),
          );
          assert.equal(result.importedMessageCount, 2);
          assert.equal(result.omittedMessageCount, 1);

          const records = yield* threads.getThreadRecords(result.threadId, ["messages"]);
          const texts = records.messages.map((entry) => entry.text);
          assert.equal(texts.length, 3);
          assert.isTrue(texts[0]!.startsWith("MIDDLE"));
          assert.isTrue(texts[1]!.startsWith("NEWEST"));
          assert.include(texts[2]!, "Handed over.");
          assert.include(texts[2]!, "1 earlier message was left out");
        }).pipe(
          Effect.provide(
            makeTestLayer({
              name: "thread-transfer-cap",
              workspace,
              adapter: makeAdapter({ captured, hold: false }),
            }),
          ),
        );
      }),
    ),
  );

  it("caps by message count and by bytes, always keeping a contiguous newest suffix", () => {
    const many = Array.from({ length: THREAD_TRANSFER_MAX_MESSAGES + 3 }, (_, index) =>
      message("user", `m${index}`, 0),
    );
    const capped = ThreadTransfer.capTransferMessages(many);
    assert.equal(capped.kept.length, THREAD_TRANSFER_MAX_MESSAGES);
    assert.equal(capped.omitted, 3);
    assert.equal(capped.kept[0]!.text, "m3");
    assert.equal(capped.kept.at(-1)!.text, `m${THREAD_TRANSFER_MAX_MESSAGES + 2}`);

    assert.deepStrictEqual(ThreadTransfer.capTransferMessages([]), { kept: [], omitted: 0 });

    // An oversized message in the middle ends the walk; older messages are not skipped over it.
    const huge = "y".repeat(THREAD_TRANSFER_MAX_BYTES + 1);
    const withHuge = ThreadTransfer.capTransferMessages([
      message("user", "old", 1),
      message("assistant", huge, 2),
      message("user", "new", 3),
    ]);
    assert.deepStrictEqual(
      withHuge.kept.map((entry) => entry.text),
      ["new"],
    );
    assert.equal(withHuge.omitted, 2);
  });
});
