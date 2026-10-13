import * as StudioAssetFiles from "../../../campaigns/studio/StudioAssetFiles.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type StudioCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import * as CampaignThreadNotifier from "../../../campaigns/CampaignThreadNotifier.ts";
import * as GenerationService from "../../../campaigns/generation/GenerationService.ts";
import * as StudioMedia from "../../../campaigns/studio/StudioMedia.ts";
import * as StudioService from "../../../campaigns/studio/StudioService.ts";
import * as StudioStore from "../../../campaigns/studio/StudioStore.ts";
import * as MediaService from "../../../media/MediaService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { StudioToolkit, StudioToolkitHandlersLive } from "./studioTools.ts";

const threadId = ThreadId.make("studio-mcp-own");
const otherThreadId = ThreadId.make("studio-mcp-other");
const scopeWith = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  thread: ThreadId = threadId,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("studio-mcp-environment"),
  threadId: thread,
  providerSessionId: "studio-mcp-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "studio-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "studio-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// Exercise the actual permission decisions through MCP and the real service/store.
// Only workspace lookup and provider/media execution are external test dependencies.
const harness = <E>(
  body: (input: {
    campaignId: string;
    call: (
      scope: McpInvocationContext.McpInvocationScope,
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<Record<string, unknown>, never, McpServer.McpServer>;
  }) => Effect.Effect<void, E, McpServer.McpServer>,
) => {
  const campaigns = CampaignStore.layer.pipe(
    Layer.provide(
      Layer.succeed(CampaignThreadNotifier.CampaignThreadNotifier, { tell: () => Effect.void }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const studio = StudioService.layer.pipe(
    Layer.provide(Layer.mock(StudioAssetFiles.StudioAssetFiles)({})),
    Layer.provideMerge(StudioStore.layer.pipe(Layer.provideMerge(campaigns))),
    Layer.provide(
      Layer.mock(GenerationService.GenerationService)({
        campaignBudget: () =>
          Effect.succeed({
            budgetUsd: null,
            reservedUsd: 0,
            availableUsd: null,
            confirmedUsd: null,
            unreportedCount: 0,
            unresolvedSubmissions: 0,
          }),
      }),
    ),
    Layer.provide(Layer.mock(StudioMedia.StudioMedia)({})),
    Layer.provide(Layer.mock(MediaService.MediaService)({})),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ projectId: "project", worktreePath: null, deletedAt: null } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" } as never)),
      }),
    ),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(NodeServices.layer),
  );
  const layer = McpServer.toolkit(StudioToolkit).pipe(
    Layer.provide(StudioToolkitHandlersLive),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(studio),
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      const owner = yield* store.upsertClient({ name: "Studio MCP", brandNotes: "", doNotSay: [] });
      const campaign = yield* store.upsertCampaign({ clientId: owner.id, name: "Test" });
      yield* body({
        campaignId: campaign.id,
        call: (scope, name, args) =>
          Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const result = yield* server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
            return {
              ...(result.structuredContent as Record<string, unknown> | undefined),
              isError: result.isError ?? false,
              message: result.content
                .flatMap((item) => (item.type === "text" ? [item.text] : []))
                .join("\n"),
            } as Record<string, unknown>;
          }).pipe(Effect.orDie),
      });
    }).pipe(Effect.provide(layer)),
  );
};
const save = (
  campaignId: string,
  sourceThreadId = threadId,
  expectedRevision = 0,
): StudioCommand => ({
  command: "studio.save",
  campaignId,
  expectedRevision,
  brief: { ...StudioStore.emptyStudio(campaignId).brief, sourceThreadId },
  scenes: [],
});

it.effect(
  "requires campaigns capability for both Studio MCP tools before reading or mutating",
  () =>
    harness(({ campaignId, call }) =>
      Effect.gen(function* () {
        for (const capabilities of [[], ["media"]] as const) {
          const scope = scopeWith(capabilities);
          for (const [name, args] of [
            ["campaign_studio_read", { campaignId: "missing" }],
            ["campaign_studio_edit", { action: save(campaignId) }],
          ] as const) {
            const result = yield* call(scope, name, args);
            expect(result.isError, name).toBe(true);
            expect(result.message, name).toContain("Campaign tools are disabled");
          }
        }
        const state = yield* call(scopeWith(["campaigns"]), "campaign_studio_read", { campaignId });
        expect(state.campaignId).toBe(campaignId);
        expect(state.revision).toBe(0);
        expect(state.scenes).toEqual([]);
      }),
    ),
);

it.effect(
  "binds edits to the credential's agent thread and rejects forged person identity or other-thread links",
  () =>
    harness(({ campaignId, call }) =>
      Effect.gen(function* () {
        const scope = scopeWith(["campaigns"]);
        const spoofed = yield* call(scope, "campaign_studio_edit", {
          action: save(campaignId, otherThreadId),
          actor: { kind: "person" },
          threadId: otherThreadId,
        });
        expect(spoofed.isError).toBe(true);
        expect(spoofed.message).toContain("own conversation");
        const saved = yield* call(scope, "campaign_studio_edit", { action: save(campaignId) });
        expect(saved.revision).toBe(1);
        expect(saved.brief).toMatchObject({ sourceThreadId: threadId });
        const foreign = yield* call(
          scopeWith(["campaigns"], otherThreadId),
          "campaign_studio_edit",
          {
            action: save(campaignId, otherThreadId, 1),
          },
        );
        expect(foreign.isError).toBe(true);
        expect(foreign.message).toContain("conversation linked");
        const state = yield* call(scope, "campaign_studio_read", { campaignId });
        expect(state.revision).toBe(1);
        expect(state.brief).toMatchObject({ sourceThreadId: threadId });
      }),
    ),
);

it.effect(
  "refuses agent approval, revocation, paid narration and post creation through the registered edit tool",
  () =>
    harness(({ campaignId, call }) =>
      Effect.gen(function* () {
        const scope = scopeWith(["campaigns"]);
        yield* call(scope, "campaign_studio_edit", { action: save(campaignId) });
        const commands: StudioCommand[] = [
          { command: "studio.asset.approve", campaignId, assetId: "asset" },
          { command: "studio.asset.approve", campaignId, assetId: "asset", approved: false },
          { command: "studio.render.approve", campaignId, renderId: "render" },
          { command: "studio.render.approve", campaignId, renderId: "render", approved: false },
          {
            command: "studio.narrate",
            campaignId,
            expectedRevision: 1,
            text: "Hello",
            allowanceUsd: 1,
            requestId: "paid-once",
          },
          {
            command: "studio.post",
            campaignId,
            renderId: "render",
            platforms: ["instagram"],
            captions: { default: "Hello", byPlatform: {} },
          },
        ];
        for (const action of commands) {
          const result = yield* call(scope, "campaign_studio_edit", {
            action,
            actor: { kind: "person" },
          });
          expect(result.isError, action.command).toBe(true);
          expect(result.message, action.command).toContain("person");
        }
        const state = yield* call(scope, "campaign_studio_read", { campaignId });
        expect(state.revision).toBe(1);
        expect(state.assets).toEqual([]);
        expect(state.renders).toEqual([]);
      }),
    ),
);
