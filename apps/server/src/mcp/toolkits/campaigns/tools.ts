import {
  CAMPAIGN_PLATFORMS,
  CampaignApprovalMode,
  CampaignError,
  CampaignPlatform,
  CampaignPostStatus,
  CampaignSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as CampaignStore from "../../../campaigns/CampaignStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, CampaignStore.CampaignStore];

/** The most posts one listing returns, newest last. */
export const CAMPAIGN_POST_LIST_MAX = 100;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

const ListedClient = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  brandNotes: Schema.String,
  /** Phrases no caption for this client may contain. */
  doNotSay: Schema.Array(Schema.String),
  approvalMode: CampaignApprovalMode,
});

const ListedCampaign = Schema.Struct({
  ...CampaignSummary.fields,
  /** What happens to a post an agent submits here: the campaign's mode, else its client's. */
  effectiveApprovalMode: CampaignApprovalMode,
});

export const CampaignListResult = Schema.Struct({
  clients: Schema.Array(ListedClient),
  campaigns: Schema.Array(ListedCampaign),
});
export type CampaignListResult = typeof CampaignListResult.Type;

const PostSummary = Schema.Struct({
  id: Schema.String,
  status: CampaignPostStatus,
  platforms: Schema.Array(CampaignPlatform),
  title: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Schema.String),
  /** True when a person asked for changes that have not been answered yet. */
  hasChangeRequest: Schema.Boolean,
});

export const CampaignPostListResult = Schema.Struct({
  posts: Schema.Array(PostSummary),
  /** True when the campaign has more posts than were returned. */
  truncated: Schema.Boolean,
});
export type CampaignPostListResult = typeof CampaignPostListResult.Type;

const PublishedTo = Schema.Struct({
  success: Schema.Boolean,
  postId: Schema.optional(Schema.String),
  link: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  at: Schema.String,
});

export const CampaignPostReadResult = Schema.Struct({
  id: Schema.String,
  campaignId: Schema.String,
  status: CampaignPostStatus,
  platforms: Schema.Array(CampaignPlatform),
  defaultCaption: Schema.String,
  captions: Schema.Record(Schema.String, Schema.String),
  mediaPaths: Schema.Array(Schema.String),
  mediaUrls: Schema.Array(Schema.String),
  title: Schema.optional(Schema.String),
  destinationUrl: Schema.optional(Schema.String),
  scheduledAt: Schema.optional(Schema.String),
  /** What a person asked to change the last time they sent it back. Answer it, then submit again. */
  changeRequest: Schema.optional(Schema.String),
  /** What happens when this post is submitted: the campaign's mode, else its client's. */
  effectiveApprovalMode: CampaignApprovalMode,
  /** The do-not-say phrases of the post's client. */
  doNotSay: Schema.Array(Schema.String),
  publishResults: Schema.Record(Schema.String, PublishedTo),
});
export type CampaignPostReadResult = typeof CampaignPostReadResult.Type;

export const CampaignPostSaveInput = Schema.Struct({
  campaignId: Id.annotate({ description: "The campaign to put the post in, from campaign_list." }),
  postId: Schema.optional(
    Id.annotate({
      description:
        "Edit this post instead of creating one. Only a draft, or a post waiting for approval (which goes back to a draft), can be edited.",
    }),
  ),
  platforms: Schema.Array(CampaignPlatform)
    .check(Schema.isMinLength(1), Schema.isMaxLength(CAMPAIGN_PLATFORMS.length))
    .annotate({ description: `Where it should go: ${CAMPAIGN_PLATFORMS.join(", ")}.` }),
  defaultCaption: Text(10_000).annotate({
    description: "The caption used for any platform that has no caption of its own below.",
  }),
  captions: Schema.optional(
    Schema.Record(Schema.String, Text(10_000)).annotate({
      description:
        "A caption per platform, keyed by platform name. Write one for each platform: length, tone and hashtags differ.",
    }),
  ),
  mediaPaths: Schema.optional(
    Schema.Array(Text(2_048)).check(Schema.isMaxLength(20)).annotate({
      description:
        "Image or video files in this thread's folder, relative to it. Needed for instagram, tiktok, youtube and pinterest.",
    }),
  ),
  mediaUrls: Schema.optional(
    Schema.Array(Text(2_048)).check(Schema.isMaxLength(20)).annotate({
      description:
        "Public web addresses of the media. A publishing service needs these; a local file alone cannot be posted to it.",
    }),
  ),
  title: Schema.optional(
    Text(200).annotate({ description: "Required for Pinterest, at most 100 characters." }),
  ),
  destinationUrl: Schema.optional(
    Text(2_048).annotate({ description: "The link a pin points to. Required for Pinterest." }),
  ),
  scheduledAt: Schema.optional(
    Text(64).annotate({
      description:
        "When it should go out, ISO 8601 with a time zone, for example 2026-10-12T15:00:00Z. Only a proposal: the person's setting and approval decide.",
    }),
  ),
});
export type CampaignPostSaveInput = typeof CampaignPostSaveInput.Type;

export const CampaignPostSaveResult = Schema.Struct({
  id: Schema.String,
  status: CampaignPostStatus,
  note: Schema.String,
});
export type CampaignPostSaveResult = typeof CampaignPostSaveResult.Type;

export const CampaignPostSubmitResult = Schema.Struct({
  id: Schema.String,
  status: CampaignPostStatus,
  /** In words: what happens to the post now, and what the agent should do next. */
  outcome: Schema.String,
});
export type CampaignPostSubmitResult = typeof CampaignPostSubmitResult.Type;

const CampaignListTool = Tool.make("campaign_list", {
  description:
    "List the clients and campaigns you can make social posts for, with each client's brand notes and do-not-say phrases, the approval mode that applies to each campaign, and how many posts it has in each status. Start here. A person sets the approval mode and only a person can change it.",
  success: CampaignListResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List campaigns")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CampaignPostListTool = Tool.make("campaign_post_list", {
  description:
    "List the posts in one campaign with their status, platforms and proposed time. Use campaign_post_read for a post's captions and for any change a person asked for.",
  parameters: Schema.Struct({
    campaignId: Id.annotate({ description: "A campaign id from campaign_list." }),
    status: Schema.optional(
      CampaignPostStatus.annotate({ description: "Only posts in this status." }),
    ),
  }),
  success: CampaignPostListResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List campaign posts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CampaignPostReadTool = Tool.make("campaign_post_read", {
  description:
    "Read one post in full: captions, media, proposed time, results of any attempt to publish it, and changeRequest, the note a person left the last time they sent it back. If there is a changeRequest, answer it with campaign_post_save, then send it back with campaign_post_submit.",
  parameters: Schema.Struct({ postId: Id }),
  success: CampaignPostReadResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a campaign post")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CampaignPostSaveTool = Tool.make("campaign_post_save", {
  description:
    "Create a post in a campaign, or edit one of yours, as a draft. Nothing is sent: a draft only exists in the campaign board. Write a caption for each platform rather than one for all. Before saving, read the client's doNotSay list from campaign_list and keep every phrase out of every caption; a post that contains one cannot be submitted. Pinterest needs a title (100 characters at most) and a destinationUrl. Instagram, TikTok, YouTube and Pinterest need an image or video. Saving over a post that was waiting for approval returns it to a draft. When the post is ready, call campaign_post_submit.",
  parameters: CampaignPostSaveInput,
  success: CampaignPostSaveResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Save a campaign post draft")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CampaignPostSubmitTool = Tool.make("campaign_post_submit", {
  description:
    "Say a draft is ready. What happens next is decided by the approval mode a person set for this client or campaign, not by you. Under ask-first (the default) the post waits for a person to approve it and nothing goes out. Under report-when-done or auto-publish the person's setting approves it, and it is posted at its proposed time, or at once if it has none. You cannot approve, reject, publish or change a mode yourself. Fails, naming what is missing, when the post is not complete.",
  parameters: Schema.Struct({ postId: Id }),
  success: CampaignPostSubmitResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Submit a campaign post")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const CampaignsToolkit = Toolkit.make(
  CampaignListTool,
  CampaignPostListTool,
  CampaignPostReadTool,
  CampaignPostSaveTool,
  CampaignPostSubmitTool,
);
