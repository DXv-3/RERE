import { CampaignError, type CampaignPost } from "@t3tools/contracts";
import { effectiveMode } from "@t3tools/shared/campaignRules";
import * as Effect from "effect/Effect";

import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  CAMPAIGN_POST_LIST_MAX,
  CampaignsToolkit,
  type CampaignListResult,
  type CampaignPostReadResult,
  type CampaignPostSaveResult,
  type CampaignPostSubmitResult,
} from "./tools.ts";

/** What the agent is told after a submit, in words: what happens to the post and what to do next. */
export function describeSubmit(post: Pick<CampaignPost, "status" | "scheduledAt">): string {
  switch (post.status) {
    case "needs-approval":
      return "The post is waiting for a person to approve it. Nothing has been sent. If they ask for changes you will be told, and can read them with campaign_post_read.";
    case "scheduled":
      return `A person's setting approved this post. It is scheduled and will be posted at ${post.scheduledAt ?? "its proposed time"}.`;
    case "approved":
      return "A person's setting approved this post. It will be posted shortly.";
    default:
      return `The post is now ${post.status}.`;
  }
}

const denied = (scope: McpInvocationContext.McpInvocationScope) =>
  new CampaignError({
    reason: "not_allowed",
    message: McpInvocationContext.capabilityDeniedMessage(
      scope,
      "campaigns",
      "This credential cannot use campaigns.",
    ),
  });

/** Every handler checks the Campaigns group first, so the owner's switch applies to the next call. */
const guarded = <A, E, R>(
  use: (scope: McpInvocationContext.McpInvocationScope) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("campaigns")) return yield* denied(scope);
    return yield* use(scope);
  });

const asAgent = (scope: McpInvocationContext.McpInvocationScope) =>
  ({ kind: "agent", threadId: scope.threadId }) as const;

export const CampaignsToolkitHandlersLive = CampaignsToolkit.toLayer({
  campaign_list: () =>
    guarded(() =>
      Effect.gen(function* () {
        const store = yield* CampaignStore.CampaignStore;
        const clients = yield* store.listClients;
        const campaigns = yield* store.listCampaigns();
        const byId = new Map(clients.map((client) => [client.id, client]));
        return {
          clients: clients.map(({ id, name, brandNotes, doNotSay, approvalMode }) => ({
            id,
            name,
            brandNotes,
            doNotSay,
            approvalMode,
          })),
          campaigns: campaigns.flatMap((campaign) => {
            const client = byId.get(campaign.clientId);
            return client === undefined
              ? []
              : [{ ...campaign, effectiveApprovalMode: effectiveMode(client, campaign) }];
          }),
        } satisfies CampaignListResult;
      }),
    ),
  campaign_post_list: (input) =>
    guarded(() =>
      Effect.gen(function* () {
        const store = yield* CampaignStore.CampaignStore;
        yield* store.getCampaign(input.campaignId);
        const all = (yield* store.listPosts(input.campaignId)).filter(
          (post) => input.status === undefined || post.status === input.status,
        );
        return {
          posts: all.slice(0, CAMPAIGN_POST_LIST_MAX).map((post) => ({
            id: post.id,
            status: post.status,
            platforms: post.platforms,
            ...(post.title === undefined ? {} : { title: post.title }),
            ...(post.scheduledAt === undefined ? {} : { scheduledAt: post.scheduledAt }),
            hasChangeRequest: post.changeRequest !== undefined,
          })),
          truncated: all.length > CAMPAIGN_POST_LIST_MAX,
        };
      }),
    ),
  campaign_post_read: (input) =>
    guarded(() =>
      Effect.gen(function* () {
        const store = yield* CampaignStore.CampaignStore;
        const post = yield* store.getPost(input.postId);
        const { client, campaign } = yield* store.contextOf(post);
        return {
          id: post.id,
          campaignId: post.campaignId,
          status: post.status,
          platforms: post.platforms,
          defaultCaption: post.captions.default,
          captions: post.captions.byPlatform,
          mediaPaths: post.mediaPaths,
          mediaUrls: post.mediaUrls,
          ...(post.title === undefined ? {} : { title: post.title }),
          ...(post.destinationUrl === undefined ? {} : { destinationUrl: post.destinationUrl }),
          ...(post.scheduledAt === undefined ? {} : { scheduledAt: post.scheduledAt }),
          ...(post.changeRequest === undefined ? {} : { changeRequest: post.changeRequest }),
          effectiveApprovalMode: effectiveMode(client, campaign),
          doNotSay: client.doNotSay,
          publishResults: post.publishResults,
        } satisfies CampaignPostReadResult;
      }),
    ),
  campaign_post_save: (input) =>
    guarded((scope) =>
      Effect.gen(function* () {
        const store = yield* CampaignStore.CampaignStore;
        const post = yield* store.savePost(asAgent(scope), {
          ...(input.postId === undefined ? {} : { id: input.postId }),
          campaignId: input.campaignId,
          platforms: input.platforms,
          captions: { default: input.defaultCaption, byPlatform: input.captions ?? {} },
          mediaPaths: input.mediaPaths ?? [],
          mediaUrls: input.mediaUrls ?? [],
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.destinationUrl === undefined ? {} : { destinationUrl: input.destinationUrl }),
          ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
        });
        return {
          id: post.id,
          status: post.status,
          note: "Saved as a draft. Nothing has been sent. Call campaign_post_submit when it is ready.",
        } satisfies CampaignPostSaveResult;
      }),
    ),
  campaign_post_submit: (input) =>
    guarded((scope) =>
      Effect.gen(function* () {
        const store = yield* CampaignStore.CampaignStore;
        const post = yield* store.submitPost(asAgent(scope), input.postId);
        return {
          id: post.id,
          status: post.status,
          outcome: describeSubmit(post),
        } satisfies CampaignPostSubmitResult;
      }),
    ),
});
