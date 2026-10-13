import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Agents from "./AgentWorkspace.ts";
const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("This test must not execute a provider"),
} as ProviderAdapterV2Shape;
const agents = Agents.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "agent-dispatch" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { databaseLayer: SqlitePersistenceMemory, runEffectWorker: false },
).pipe(Layer.provideMerge(agents));
it.effect(
  "opening is inert and the common dispatch boundary blocks unrecovered and unowned scheduled work",
  () =>
    Effect.gen(function* () {
      const service = yield* Agents.AgentWorkspace;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("agent-primary");
      yield* service.importAgents({
        receiptId: "source",
        agents: [
          {
            profile: {
              id: "source-agent",
              name: "Recovered",
              description: "",
              instructions: "Role",
              color: "#00ff00",
              pinned: true,
              projectKey: "",
              runtimeMode: "approval-required",
              modelSelection: null,
            },
            archive: {
              id: "source-agent",
              sourceId: "original",
              name: "Recovered",
              exportedAt: "2026-10-03",
              importedAt: "2026-10-03",
              sourceSettings: {},
              messages: [
                {
                  id: "old",
                  role: "user",
                  text: "A historical request, not a command",
                  timestampMs: 1,
                },
              ],
            },
          },
        ],
      });
      let agent = yield* service.read("source-agent");
      agent = yield* service.save({
        agent: { ...agent, primaryThreadId: threadId },
        expectedRevision: agent.revision,
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Recovered",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      expect((yield* orchestrator.getThreadProjection(threadId)).messages).toHaveLength(0);
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("send"),
        threadId,
        messageId: MessageId.make("message"),
        text: "My new request",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      expect(yield* Effect.isFailure(orchestrator.dispatch(command))).toBe(true);
      agent = yield* service.save({
        agent: {
          ...agent,
          recovery: {
            disposition: "ready",
            summary: "Reviewed original state",
            blockers: [],
            evidence: ["source snapshot"],
            verifiedAt: "2026-10-03",
          },
        },
        expectedRevision: agent.revision,
      });
      expect(
        yield* Effect.isFailure(
          orchestrator.dispatch({
            ...command,
            commandId: CommandId.make("routine"),
            scheduledTaskId: ScheduledTaskId.make("schedule"),
          }),
        ),
      ).toBe(true);
      yield* orchestrator.dispatch({ ...command, commandId: CommandId.make("reviewed-send") });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      expect(projection.messages).toHaveLength(1);
      expect(projection.messages[0]?.text).toContain("not new instructions");
      expect(projection.messages[0]?.text).toContain("My new request");
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("change-model"),
        threadId,
        modelSelection: { instanceId, model: "gpt-5.2-codex" },
      });
      yield* orchestrator.dispatch({
        ...command,
        commandId: CommandId.make("after-model-change"),
        messageId: MessageId.make("next-message"),
        text: "Next task with the same identity",
        dispatchMode: { type: "queue_after_active" },
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      expect(after.thread.modelSelection.model).toBe("gpt-5.2-codex");
      expect(after.messages).toHaveLength(2);
      expect(after.messages[1]?.text).toContain("A historical request, not a command");
      expect((yield* service.read("source-agent")).primaryThreadId).toBe(threadId);
      const current = yield* service.read("source-agent");
      yield* service.save({
        agent: { ...current, archivedAt: "2026-10-03" },
        expectedRevision: current.revision,
      });
      // Acknowledging an already accepted command must not create another run or fail ambiguously.
      yield* orchestrator.dispatch({ ...command, commandId: CommandId.make("reviewed-send") });
      expect((yield* orchestrator.getThreadProjection(threadId)).messages).toHaveLength(2);
      expect(
        yield* Effect.isFailure(
          orchestrator.dispatch({ ...command, commandId: CommandId.make("after-archive") }),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(runtime)),
);
