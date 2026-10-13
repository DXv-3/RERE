import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import * as CampaignThreadNotifier from "../../../campaigns/CampaignThreadNotifier.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { restrictScope } from "../../AgentToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CampaignsToolkitHandlersLive, describeSubmit } from "./handlers.ts";
import { CampaignsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-agent-campaigns");

const scopeWith = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-campaigns"),
  threadId,
  providerSessionId: "provider-session-campaigns",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "campaigns", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "campaigns", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const notifier = Layer.succeed(
  CampaignThreadNotifier.CampaignThreadNotifier,
  CampaignThreadNotifier.CampaignThreadNotifier.of({ tell: () => Effect.void }),
);
const storeLayer = CampaignStore.layer.pipe(
  Layer.provide(notifier),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const toolLayer = McpServer.toolkit(CampaignsToolkit).pipe(
  Layer.provide(CampaignsToolkitHandlersLive),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(storeLayer),
);

const call = (
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

/** The tool result as data. Failures come back as results, so both read the same way. */
const dataOf = (result: McpSchema.CallToolResult) =>
  (result.structuredContent ?? {}) as Record<string, any>;

const seedCampaign = (mode: "ask-first" | "report-when-done" | "auto-publish") =>
  Effect.gen(function* () {
    const store = yield* CampaignStore.CampaignStore;
    const owner = yield* store.upsertClient({
      name: "Candid Studios",
      brandNotes: "Warm and plain",
      doNotSay: ["cheapest"],
      approvalMode: mode,
    });
    const campaign = yield* store.upsertCampaign({ clientId: owner.id, name: "October reels" });
    return { store, campaignId: campaign.id };
  });

const draftArgs = (campaignId: string, overrides: Record<string, unknown> = {}) => ({
  campaignId,
  platforms: ["facebook", "linkedin"],
  defaultCaption: "Fresh work from the studio",
  captions: { linkedin: "A behind-the-scenes look at our October shoots" },
  ...overrides,
});

it("offers no tool that approves, rejects, publishes, retries, or changes a mode or the connection", () => {
  const names = Object.keys(CampaignsToolkit.tools).toSorted();
  expect(names).toEqual([
    "campaign_list",
    "campaign_post_list",
    "campaign_post_read",
    "campaign_post_save",
    "campaign_post_submit",
  ]);
  for (const name of names) expect(name).not.toMatch(/approve|reject|publish|retry|mode|connect/);
  // And no tool takes a field that could set an approval or a mode. The only `status` is the
  // read-only filter on campaign_post_list.
  for (const [name, tool] of Object.entries(CampaignsToolkit.tools)) {
    const fields = (
      tool.parametersSchema.ast as { propertySignatures?: ReadonlyArray<{ name: string }> }
    ).propertySignatures?.map((field) => field.name);
    for (const field of fields ?? []) {
      expect(field, name).not.toMatch(/approv|mode|publish/i);
      if (field === "status") expect(name).toBe("campaign_post_list");
    }
  }
});

it("tells the agent to write per-platform captions, check do-not-say, submit, and that the mode decides", () => {
  const save = CampaignsToolkit.tools.campaign_post_save.description ?? "";
  expect(save).toMatch(/caption for each platform/);
  expect(save).toMatch(/doNotSay/);
  expect(save).toMatch(/campaign_post_submit/);
  const submit = CampaignsToolkit.tools.campaign_post_submit.description ?? "";
  expect(submit).toMatch(/approval mode a person set/);
  expect(submit).toMatch(/cannot approve/);
});

it.effect("lists clients and campaigns with the mode that applies", () =>
  Effect.gen(function* () {
    const { campaignId } = yield* seedCampaign("report-when-done");
    const result = dataOf(yield* call(scopeWith(["campaigns"]), "campaign_list"));
    expect(result.clients[0].doNotSay).toEqual(["cheapest"]);
    expect(result.campaigns[0].id).toBe(campaignId);
    expect(result.campaigns[0].effectiveApprovalMode).toBe("report-when-done");
    expect(result.campaigns[0].postCounts).toEqual({});
  }).pipe(Effect.provide(toolLayer)),
);

it.effect("saves a draft in the calling thread's name and waits for a person under ask-first", () =>
  Effect.gen(function* () {
    const { store, campaignId } = yield* seedCampaign("ask-first");
    const scope = scopeWith(["campaigns"]);
    const saved = dataOf(yield* call(scope, "campaign_post_save", draftArgs(campaignId)));
    expect(saved.status).toBe("draft");
    const post = yield* store.getPost(saved.id);
    expect(post.createdBy).toEqual({ kind: "agent", threadId });
    expect(post.sourceThreadId).toBe(threadId);
    expect(post.captions.byPlatform).toEqual({
      linkedin: "A behind-the-scenes look at our October shoots",
    });

    const submitted = dataOf(yield* call(scope, "campaign_post_submit", { postId: saved.id }));
    expect(submitted.status).toBe("needs-approval");
    expect(submitted.outcome).toMatch(/waiting for a person/);

    const listed = dataOf(yield* call(scope, "campaign_post_list", { campaignId }));
    expect(listed.posts.map((entry: { status: string }) => entry.status)).toEqual([
      "needs-approval",
    ]);

    // Once it is waiting, an agent cannot approve it by editing it into another state: the edit
    // takes it back to a draft, and a person is still the only one who approves.
    const edited = dataOf(
      yield* call(scope, "campaign_post_save", { ...draftArgs(campaignId), postId: saved.id }),
    );
    expect(edited.status).toBe("draft");
  }).pipe(Effect.provide(toolLayer)),
);

it.effect("is approved by the person's setting under auto-publish, and then cannot be edited", () =>
  Effect.gen(function* () {
    const { store, campaignId } = yield* seedCampaign("auto-publish");
    const scope = scopeWith(["campaigns"]);
    const saved = dataOf(yield* call(scope, "campaign_post_save", draftArgs(campaignId)));
    const submitted = dataOf(yield* call(scope, "campaign_post_submit", { postId: saved.id }));
    expect(submitted.status).toBe("approved");
    expect((yield* store.getPost(saved.id)).approval?.by).toBe("mode");

    const refused = yield* call(scope, "campaign_post_save", {
      ...draftArgs(campaignId),
      postId: saved.id,
    });
    expect(dataOf(refused).reason).toBe("not_allowed");
    expect((yield* store.getPost(saved.id)).status).toBe("approved");
  }).pipe(Effect.provide(toolLayer)),
);

it.effect("refuses a caption with a do-not-say phrase and shows the person's change request", () =>
  Effect.gen(function* () {
    const { store, campaignId } = yield* seedCampaign("ask-first");
    const scope = scopeWith(["campaigns"]);
    const risky = dataOf(
      yield* call(
        scope,
        "campaign_post_save",
        draftArgs(campaignId, { defaultCaption: "The cheapest shoot" }),
      ),
    );
    const blocked = dataOf(yield* call(scope, "campaign_post_submit", { postId: risky.id }));
    expect(blocked.reason).toBe("invalid");
    expect(blocked.message).toMatch(/do-not-say/);

    const good = dataOf(yield* call(scope, "campaign_post_save", draftArgs(campaignId)));
    yield* call(scope, "campaign_post_submit", { postId: good.id });
    yield* store.requestChanges({ postId: good.id, text: "Shorter, please" });
    const read = dataOf(yield* call(scope, "campaign_post_read", { postId: good.id }));
    expect(read.changeRequest).toBe("Shorter, please");
    expect(read.status).toBe("draft");
    expect(read.doNotSay).toEqual(["cheapest"]);
    expect(read.effectiveApprovalMode).toBe("ask-first");
  }).pipe(Effect.provide(toolLayer)),
);

it.effect("refuses every tool once the owner switches Campaigns off", () =>
  Effect.gen(function* () {
    const { campaignId } = yield* seedCampaign("ask-first");
    const off = restrictScope(scopeWith(["campaigns"]), ["campaigns"]);
    for (const [name, args] of [
      ["campaign_list", {}],
      ["campaign_post_list", { campaignId }],
      ["campaign_post_read", { postId: "x" }],
      ["campaign_post_save", draftArgs(campaignId)],
      ["campaign_post_submit", { postId: "x" }],
    ] as const) {
      const result = dataOf(yield* call(off, name, args));
      expect(result.message, name).toBe("This agent's Campaigns access is switched off.");
    }
  }).pipe(Effect.provide(toolLayer)),
);

it("describes what happens after a submit", () => {
  expect(describeSubmit({ status: "needs-approval" })).toMatch(/waiting for a person/);
  expect(describeSubmit({ status: "scheduled", scheduledAt: "2026-10-12T15:00:00.000Z" })).toMatch(
    /2026-10-12T15:00:00.000Z/,
  );
  expect(describeSubmit({ status: "approved" })).toMatch(/posted shortly/);
});
