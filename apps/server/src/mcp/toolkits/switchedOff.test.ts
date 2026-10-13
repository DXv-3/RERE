import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { restrictScope } from "../AgentToolAccess.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import { AttachmentHandlersLive } from "./attachment/handlers.ts";
import { AttachmentToolkit } from "./attachment/tools.ts";
import { EnvironmentHandlersLive } from "./environment/handlers.ts";
import { EnvironmentToolkit } from "./environment/tools.ts";
import { ProjectHandlersLive } from "./project/handlers.ts";
import { ProjectToolkit } from "./project/tools.ts";
import { ThreadToolkitHandlersLive } from "./thread/handlers.ts";
import { ThreadToolkit } from "./thread/tools.ts";

const SWITCHED_OFF = "This agent's Other Conversations access is switched off.";
const ownThreadId = ThreadId.make("thread-agent-own");
const otherThreadId = ThreadId.make("thread-somebody-else");
const projectId = ProjectId.make("project-toolkit-switches");
const instanceId = ProviderInstanceId.make("codex");

const fullScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-toolkit-switches"),
  threadId: ownThreadId,
  providerSessionId: "provider-session-toolkit-switches",
  providerInstanceId: instanceId,
  capabilities: new Set(["orchestration", "worktree"]),
  issuedAt: 1,
};
const switchedOff = restrictScope(fullScope, ["orchestration"]);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "switched-off", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "switched-off", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const ownShell = {
  id: ownThreadId,
  projectId,
  deletedAt: null,
  archivedAt: null,
  activeRunId: RunId.make("run-live"),
  providerInstanceId: instanceId,
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId, model: "gpt-5.4" },
} as unknown as OrchestrationV2ThreadShell;

/** Only the calling thread exists; looking up any other thread would die and fail the test. */
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    threadId === ownThreadId ? Effect.succeed(ownShell) : Effect.die(`looked up ${threadId}`),
  getProjectThreadRecords: ({ threadId }) =>
    threadId === ownThreadId
      ? Effect.succeed({
          thread: { ...ownShell, id: ownThreadId },
          runtimeRequests: [],
          contextTransfers: [],
          turnItems: [],
          runs: [],
          messages: [],
        } as never)
      : Effect.die(`looked up ${threadId}`),
  dispatch: () => Effect.die("dispatched a command"),
});

const registrations = Layer.mergeAll(
  McpServer.toolkit(ThreadToolkit).pipe(Layer.provide(ThreadToolkitHandlersLive)),
  McpServer.toolkit(AttachmentToolkit).pipe(Layer.provide(AttachmentHandlersLive)),
  McpServer.toolkit(ProjectToolkit).pipe(Layer.provide(ProjectHandlersLive)),
  McpServer.toolkit(EnvironmentToolkit).pipe(Layer.provide(EnvironmentHandlersLive)),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      threads,
      NodeCrypto.layer,
      ServerSettings.layerTest({ enableAgentCrossProjectAccess: false }),
      Layer.mock(ProjectService.ProjectService)({}),
    ),
  ),
);

const call = (name: string, args: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, switchedOff),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("refuses tools that leave the thread, naming the switch", () =>
  Effect.gen(function* () {
    const reaching: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["t3_thread_search", { query: "anything" }],
      ["t3_thread_fork", { sourcePoint: { type: "latest_stable" } }],
      ["t3_thread_launch", { title: "New", message: "hi" }],
      ["t3_project_list", {}],
      ["t3_environment_read", {}],
      ["run_scheduled_task_now", { taskId: "task-1" }],
      // Any thread but the caller's own is another conversation.
      ["t3_thread_configuration", { threadId: otherThreadId }],
      ["t3_queue_list", { threadId: otherThreadId }],
      ["t3_thread_organize", { action: "pin", threadId: otherThreadId }],
      [
        "t3_thread_send_attachments",
        {
          threadId: otherThreadId,
          attachments: [
            {
              type: "image",
              id: "attachment-1",
              name: "a.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        },
      ],
    ];
    for (const [name, args] of reaching) {
      const result = yield* call(name, args);
      expect(result.structuredContent, name).toMatchObject({
        code: "capability_denied",
        message: SWITCHED_OFF,
      });
    }
  }).pipe(Effect.provide(registrations)),
);

it.effect("still lets the agent act on its own thread", () =>
  Effect.gen(function* () {
    // With no threadId these target the caller; they reach the thread lookups, not the refusal.
    for (const [name, args] of [
      ["t3_thread_configuration", {}],
      ["t3_thread_configuration", { threadId: ownThreadId }],
      ["t3_queue_list", {}],
    ] as const) {
      const result = yield* call(name, args);
      expect(result.isError, name).toBe(false);
      expect(result.structuredContent, name).not.toMatchObject({ code: "capability_denied" });
    }
    const configuration = yield* call("t3_thread_configuration", {});
    expect(configuration.structuredContent).toMatchObject({
      threadId: ownThreadId,
      runtimeMode: "full-access",
    });
  }).pipe(Effect.provide(registrations)),
);

it.effect("keeps launching into a worktree behind the Worktrees switch", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const worktreesOff = restrictScope(
      { ...fullScope, capabilities: new Set(["orchestration", "worktree"]) },
      ["worktree"],
    );
    for (const workspaceStrategy of [
      { type: "worktree", baseRef: "main" },
      { type: "existing_worktree", worktreePath: "/worktrees/a" },
    ]) {
      const result = yield* server
        .callTool({
          name: "t3_thread_launch",
          arguments: { title: "New", message: "hi", workspaceStrategy },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, worktreesOff),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.structuredContent, workspaceStrategy.type).toMatchObject({
        code: "capability_denied",
        message: "This agent's Worktrees access is switched off.",
      });
    }
  }).pipe(Effect.provide(registrations)),
);
