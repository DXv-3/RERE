import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestratorMcpFailure,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ScheduledTaskId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { restrictScope } from "./AgentToolAccess.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const SWITCHED_OFF = "This agent's Other Conversations access is switched off.";
const now = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
const ownThreadId = ThreadId.make("thread-agent-own");
const otherThreadId = ThreadId.make("thread-somebody-else");
const projectId = ProjectId.make("project-switches");

const fullScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-switches"),
  threadId: ownThreadId,
  providerSessionId: "provider-session-switches",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration", "preview", "worktree", "pull-requests"]),
  issuedAt: 1,
};
/** What the production middleware hands a tool call once the owner switched the group off. */
const switchedOffScope = restrictScope(fullScope, ["orchestration"]);

const ownProjection = {
  thread: {
    id: ownThreadId,
    projectId,
    title: "Own thread",
    createdBy: "user",
    creationSource: "mcp",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ownThreadId },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdAt: now,
    updatedAt: now,
  },
  runs: [],
  visibleTurnItems: [],
  runtimeRequests: [],
  messages: [],
  contextTransfers: [],
  subagents: [],
  updatedAt: now,
} as unknown as OrchestrationV2ThreadProjection;

/**
 * Anything that looks up a thread other than the caller's own dies, so a refusal that came too
 * late (after the lookup) fails these tests instead of passing quietly.
 */
const layer = OrchestratorMcpService.layer.pipe(
  Layer.provide(ServerSettings.layerTest({ enableAgentCrossProjectAccess: true })),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
        getThreadRecords: (threadId) =>
          threadId === ownThreadId
            ? Effect.succeed(ownProjection)
            : Effect.die(`looked up ${threadId}`),
        getThreadShell: (threadId) => Effect.die(`looked up ${threadId}`),
        getProjectThreadRecords: () => Effect.die("looked up another thread"),
        listProjectThreads: () => Effect.die("listed threads"),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.die("listed scheduled tasks"),
        upsert: () => Effect.die("scheduled a task"),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      NodeCrypto.layer,
    ),
  ),
);

it.effect("keeps the agent's own thread when Other Conversations is switched off", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const own = yield* service.readThread(switchedOffScope, { threadId: ownThreadId });
    expect(own.thread.threadId).toBe(ownThreadId);
    const capabilities = yield* service.capabilities(switchedOffScope);
    expect(capabilities.parentThreadId).toBe(ownThreadId);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a message an agent addresses to its own thread", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    for (const mode of [undefined, "queue", "steer"] as const) {
      const error = yield* Effect.flip(
        service.sendToThread(fullScope, {
          threadId: ownThreadId,
          message: "Please re-open the thread.",
          ...(mode === undefined ? {} : { mode }),
        }),
      );
      expect(error, mode ?? "auto").toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("your own thread"),
      });
    }
  }).pipe(Effect.provide(layer)),
);

/** Another thread in the same project that already has twenty messages waiting. */
const busyProjection = {
  ...ownProjection,
  thread: { ...ownProjection.thread, id: otherThreadId, title: "Busy thread" },
  runs: Array.from({ length: 20 }, (_, index) => ({ id: `run-${index}`, status: "queued" })),
} as unknown as OrchestrationV2ThreadProjection;

const busyLayer = OrchestratorMcpService.layer.pipe(
  Layer.provide(ServerSettings.layerTest({ enableAgentCrossProjectAccess: true })),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.succeed(threadId === ownThreadId ? ownProjection : busyProjection),
        getThreadShell: () => Effect.succeed(busyProjection.thread as never),
        getProjectThreadRecords: () => Effect.succeed(busyProjection),
        sendToThread: () => Effect.die("queued another message"),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.die("listed scheduled tasks"),
        upsert: () => Effect.die("scheduled a task"),
      }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      NodeCrypto.layer,
    ),
  ),
);

it.effect("refuses to pile another message onto a thread with twenty already waiting", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const error = yield* Effect.flip(
      service.sendToThread(fullScope, { threadId: otherThreadId, message: "Any progress?" }),
    );
    expect(error).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("already has 20 messages waiting"),
    });
  }).pipe(Effect.provide(busyLayer)),
);

it.effect("refuses what reaches another conversation, naming the switch", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const calls: Record<string, Effect.Effect<object, OrchestratorMcpFailure>> = {
      readOther: service.readThread(switchedOffScope, { threadId: otherThreadId }),
      sendOther: service.sendToThread(switchedOffScope, { threadId: otherThreadId, message: "hi" }),
      waitOther: service.waitForThread(switchedOffScope, { threadId: otherThreadId }),
      interruptOther: service.interruptThread(switchedOffScope, { threadId: otherThreadId }),
      list: service.listThreads(switchedOffScope, {}),
      create: service.createThreads(switchedOffScope, { threads: [{ prompt: "hi" }] }),
      delegate: service.delegateTask(switchedOffScope, { task: "do it", role: "general" }),
      taskStatus: service.taskStatus(switchedOffScope, NodeId.make("node-task")),
      schedule: service.scheduleTask(switchedOffScope, {
        prompt: "daily",
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
      listScheduled: service.listScheduledTasks(switchedOffScope),
    };
    for (const [name, call] of Object.entries(calls)) {
      const error = yield* Effect.flip(call);
      expect(error, name).toMatchObject({ code: "capability_denied", message: SWITCHED_OFF });
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("treats a credential that never held orchestration as before", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const never = { ...fullScope, capabilities: new Set<"preview">(["preview"]) };
    const error = yield* Effect.flip(service.readThread(never, { threadId: ownThreadId }));
    expect(error).toMatchObject({
      code: "capability_denied",
      message: "This MCP credential does not grant orchestration capabilities.",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps scheduled tasks that need a fresh worktree behind the Worktrees switch", () =>
  Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const worktreesOff = restrictScope(fullScope, ["worktree"]);
    const freshWorktree = {
      prompt: "daily",
      schedule: { type: "interval", everyMs: 3_600_000 },
      bindToCurrentThread: false,
    } as const;
    const refused = yield* Effect.flip(service.scheduleTask(worktreesOff, freshWorktree));
    expect(refused).toMatchObject({
      code: "capability_denied",
      message: "This agent's Worktrees access is switched off.",
    });
    const refusedUpdate = yield* Effect.flip(
      service.updateScheduledTask(worktreesOff, {
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        bindToCurrentThread: false,
      }),
    );
    expect(refusedUpdate).toMatchObject({ code: "capability_denied" });

    // A task bound to this thread creates no worktree, so it gets past the switch to the (dying) stub.
    const bound = yield* Effect.exit(
      service.scheduleTask(worktreesOff, { ...freshWorktree, bindToCurrentThread: true }),
    );
    expect(Exit.isFailure(bound) && Cause.hasDies(bound.cause)).toBe(true);
  }).pipe(Effect.provide(layer)),
);
