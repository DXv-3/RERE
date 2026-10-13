import * as AgentSecrets from "../../agents/AgentSecrets.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../../config.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Preview from "../../preview/Manager.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { restrictScope } from "../AgentToolAccess.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../PreviewAutomationBroker.ts";
import * as WorktreeMcpService from "../WorktreeMcpService.ts";
import { PreviewControlsHandlersLive } from "./previewControls/handlers.ts";
import { PreviewControlsToolkit } from "./previewControls/tools.ts";
import { WorktreeToolkitHandlersLive } from "./worktree/handlers.ts";
import { WorktreeToolkit } from "./worktree/tools.ts";

const threadId = ThreadId.make("thread-agent-own");
const projectId = ProjectId.make("project-group-switches");
const instanceId = ProviderInstanceId.make("codex");

const granted = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-group-switches"),
  threadId,
  providerSessionId: "provider-session-group-switches",
  providerInstanceId: instanceId,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "group-switches", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "group-switches", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const callAs = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const textOf = (result: McpSchema.CallToolResult) =>
  JSON.stringify([result.structuredContent, result.content]);

const BROWSER_OFF = "This agent's Browser access is switched off.";

const previewLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(
    Layer.mock(AgentSecrets.AgentSecrets)({ valuesForThread: () => Effect.succeed([]) }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-switches-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("refuses driving the browser panel with Browser switched off", () =>
  Effect.gen(function* () {
    const off = restrictScope(granted(["preview"]), ["preview"]);
    for (const [name, args] of [
      ["preview_status", {}],
      ["preview_open", { url: "http://localhost:3000" }],
      ["preview_snapshot", {}],
    ] as const) {
      const result = yield* callAs(off, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toContain(BROWSER_OFF);
    }
  }).pipe(Effect.provide(previewLayer)),
);

const previewControlsLayer = McpServer.toolkit(PreviewControlsToolkit).pipe(
  Layer.provide(PreviewControlsHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(Preview.PreviewManager)({})),
);

it.effect("refuses listing and closing preview tabs with Browser switched off", () =>
  Effect.gen(function* () {
    const off = restrictScope(granted(["preview"]), ["preview"]);
    for (const [name, args] of [
      ["t3_preview_list", {}],
      ["t3_preview_close", { tabId: "tab-1" }],
    ] as const) {
      const result = yield* callAs(off, name, args);
      // These tools return their failure, so the model reads the fields of the error.
      expect(result.structuredContent, name).toMatchObject({
        _tag: "PreviewAutomationUnavailableError",
        reason: BROWSER_OFF,
      });
    }
  }).pipe(Effect.provide(previewControlsLayer)),
);

const deviceLayer = McpHttpServer.DeviceToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(Layer.mock(DeviceService.DeviceService)({})),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-switches-device-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("refuses phone simulators with Devices switched off, and says so plainly", () =>
  Effect.gen(function* () {
    const off = restrictScope(granted(["device"]), ["device"]);
    for (const [name, args] of [
      ["device_list", {}],
      ["device_open", {}],
      ["device_screenshot", {}],
      ["device_close", {}],
    ] as const) {
      const result = yield* callAs(off, name, args);
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toContain("This agent's Devices access is switched off.");
    }
    // When the environment setting is what withheld the capability, the old wording stays.
    const environmentOff = yield* callAs(granted([]), "device_list");
    expect(textOf(environmentOff)).toContain(
      "Agent device access is turned off for this environment.",
    );
  }).pipe(Effect.provide(deviceLayer)),
);

const ownShell = {
  id: threadId,
  projectId,
  deletedAt: null,
  worktreePath: null,
} as unknown as OrchestrationV2ThreadShell;

const worktreeLayer = McpServer.toolkit(WorktreeToolkit).pipe(
  Layer.provide(WorktreeToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(WorktreeMcpService.WorktreeMcpService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(ownShell),
      }),
      // The project is missing, which is the first thing past both gates that can fail.
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
      Layer.mock(GitWorkflow.GitWorkflowService)({}),
    ),
  ),
);

it.effect("refuses listing worktrees with Worktrees switched off", () =>
  Effect.gen(function* () {
    const result = yield* callAs(
      restrictScope(granted(["worktree", "orchestration"]), ["worktree"]),
      "t3_worktree_list",
    );
    expect(result.structuredContent).toMatchObject({
      code: "capability_denied",
      message: "This agent's Worktrees access is switched off.",
    });
  }).pipe(Effect.provide(worktreeLayer)),
);

it.effect("keeps listing worktrees when only Other Conversations is switched off", () =>
  Effect.gen(function* () {
    const result = yield* callAs(
      restrictScope(granted(["worktree", "orchestration"]), ["orchestration"]),
      "t3_worktree_list",
    );
    // Past both gates: the stubbed project lookup is what answers.
    expect(result.structuredContent).toMatchObject({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }).pipe(Effect.provide(worktreeLayer)),
);
