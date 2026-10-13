import * as AgentReplies from "../../../agents/AgentReplies.ts";
import * as AgentGoals from "../../../agents/AgentGoals.ts";
import * as AgentSecrets from "../../../agents/AgentSecrets.ts";
import * as AgentWorkspace from "../../../agents/AgentWorkspace.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerConfig from "../../../config.ts";
import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import * as StudioService from "../../../campaigns/studio/StudioService.ts";
import * as MediaEdit from "../../../media/MediaEdit.ts";
import * as MediaService from "../../../media/MediaService.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const StubServicesLive = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
  Layer.mock(AgentGoals.AgentGoals)({}),
  Layer.mock(AgentReplies.AgentReplies)({}),
  Layer.mock(AgentSecrets.AgentSecrets)({}),
  // Every MCP request asks which tool groups the calling agent's owner switched off.
  Layer.mock(AgentWorkspace.AgentWorkspace)({ blockedToolGroups: () => Effect.succeed([]) }),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(MediaService.MediaService)({}),
  Layer.mock(MediaEdit.MediaEdit)({}),
  Layer.mock(CampaignStore.CampaignStore)({}),
  Layer.mock(StudioService.StudioService)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

it.live("production mcp layer lists worktree and Studio tools over HTTP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const routes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
      const appLayer = routes.pipe(
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed("environment-scratch" as never),
          }),
        ),
        Layer.provide(PreviewAutomationBroker.layer),
        Layer.provide(StubServicesLive),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" })),
        Layer.provide(NodeHttpServer.layerHttpServices),
        Layer.provide(
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
          }),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
        (app) => Effect.promise(() => app.dispose()),
      );
      // Initialize the scoped route services before issuing their MCP credential.
      // Web Request/Response exercises the HTTP transport without opening a socket.
      yield* Effect.promise(() => app.handler(new Request("http://mcp.test/missing")));

      const registry = McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-scratch"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const credential = yield* registry;
      expect(credential).toBeDefined();

      const auth = credential!.config.authorizationHeader;
      const initResponse = yield* Effect.promise(() =>
        app.handler(
          new Request("http://mcp.test/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              authorization: auth,
            },
            body: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
          }),
        ),
      );
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers.get("mcp-session-id");

      const listResponse = yield* Effect.promise(() =>
        app.handler(
          new Request("http://mcp.test/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              authorization: auth,
              "mcp-protocol-version": "2025-06-18",
              ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            },
            body: `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
          }),
        ),
      );
      const bodyText = yield* Effect.promise(() => listResponse.text());
      const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
      const tools = payload.result.tools;
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      // The worktree registration merges alongside the other toolkits rather
      // than replacing them.
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");
      expect(toolNames).toContain("media_inspect");
      expect(toolNames).toContain("media_edit");
      expect(toolNames).toContain("campaign_post_submit");
      expect(toolNames).toContain("campaign_studio_read");
      expect(toolNames).toContain("campaign_studio_edit");
      expect(toolNames).toContain("media_generate_image");
      expect(toolNames).toContain("media_generate_video");
      expect(toolNames).toContain("media_generation_status");

      // The handoff tool mutates thread state, reaches the network (origin
      // fetch), and runs project setup scripts, so its MCP hints must not
      // promise a read-only, closed-world, non-destructive tool.
      const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find((tool) => tool.name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      // MCP requires every tool input schema to be a top-level object schema.
      // A non-object schema (e.g. the anyOf produced by an empty
      // Schema.Struct({})) makes clients reject the entire server.
      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ),
);
