import * as Schema from "effect/Schema";
import { ContentStudio, StudioCommand } from "./contentStudio.ts";

import { AgentSecretValue } from "./agentSecrets.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Clients, campaigns and the posts agents prepare for them. The rules that decide who may move a
 * post between statuses live in `@t3tools/shared/campaignRules`; this module is only the wire shape.
 */

export const CAMPAIGN_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "gbp",
  "pinterest",
] as const;
export const CampaignPlatform = Schema.Literals(CAMPAIGN_PLATFORMS);
export type CampaignPlatform = typeof CampaignPlatform.Type;

export const CAMPAIGN_PLATFORM_LABELS: Readonly<Record<CampaignPlatform, string>> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  gbp: "Google Business Profile",
  pinterest: "Pinterest",
};

/** How much a person stays in the loop. Only a person may change it. */
export const CampaignApprovalMode = Schema.Literals([
  "ask-first",
  "report-when-done",
  "auto-publish",
]);
export type CampaignApprovalMode = typeof CampaignApprovalMode.Type;
export const DEFAULT_CAMPAIGN_APPROVAL_MODE: CampaignApprovalMode = "ask-first";

export const CampaignPostStatus = Schema.Literals([
  "draft",
  "needs-approval",
  "approved",
  "scheduled",
  "publishing",
  "posted",
  "failed",
  "rejected",
]);
export type CampaignPostStatus = typeof CampaignPostStatus.Type;

export const CAMPAIGN_NAME_MAX = 120;
export const CAMPAIGN_NOTES_MAX = 8_000;
export const CAMPAIGN_CAPTION_MAX = 10_000;
export const CAMPAIGN_PINTEREST_TITLE_MAX = 100;
const CAMPAIGN_ID_MAX = 128;
const CAMPAIGN_MEDIA_MAX = 20;
const CAMPAIGN_URL_MAX = 2_048;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(CAMPAIGN_ID_MAX));
const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(CAMPAIGN_NAME_MAX));

export const CampaignClient = Schema.Struct({
  id: Id,
  name: Name,
  brandNotes: text(CAMPAIGN_NOTES_MAX),
  /** Phrases a caption for this client must never contain. */
  doNotSay: Schema.Array(text(200)).check(Schema.isMaxLength(200)),
  /** The id this client has in the publishing service. */
  publishingClientId: Schema.optional(Id),
  approvalMode: CampaignApprovalMode,
  monthlySpendCapUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CampaignClient = typeof CampaignClient.Type;

export const Campaign = Schema.Struct({
  id: Id,
  clientId: Id,
  name: Name,
  /** Overrides the client's mode for this campaign when set. */
  approvalMode: Schema.optional(CampaignApprovalMode),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Campaign = typeof Campaign.Type;

export const CampaignPostCaptions = Schema.Struct({
  /** Used for every platform that has no caption of its own. */
  default: text(CAMPAIGN_CAPTION_MAX),
  byPlatform: Schema.Record(Schema.String, text(CAMPAIGN_CAPTION_MAX)),
});
export type CampaignPostCaptions = typeof CampaignPostCaptions.Type;

export const CampaignPostCreatedBy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person") }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
]);
export type CampaignPostCreatedBy = typeof CampaignPostCreatedBy.Type;

export const CampaignPostApproval = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ by: Schema.Literal("person"), at: IsoDateTime }),
    Schema.Struct({ by: Schema.Literal("mode"), mode: CampaignApprovalMode, at: IsoDateTime }),
  ]),
);
export type CampaignPostApproval = typeof CampaignPostApproval.Type;

export const CampaignPublishResult = Schema.Struct({
  success: Schema.Boolean,
  postId: Schema.optional(Schema.String),
  link: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  at: IsoDateTime,
});
export type CampaignPublishResult = typeof CampaignPublishResult.Type;

export const CampaignPost = Schema.Struct({
  id: Id,
  campaignId: Id,
  status: CampaignPostStatus,
  platforms: Schema.Array(CampaignPlatform).check(Schema.isMaxLength(CAMPAIGN_PLATFORMS.length)),
  captions: CampaignPostCaptions,
  /** Files in the source thread's folder, relative to it. */
  mediaPaths: Schema.Array(text(CAMPAIGN_URL_MAX)).check(Schema.isMaxLength(CAMPAIGN_MEDIA_MAX)),
  /** Public addresses of the media; what a publishing service fetches. */
  mediaUrls: Schema.Array(text(CAMPAIGN_URL_MAX)).check(Schema.isMaxLength(CAMPAIGN_MEDIA_MAX)),
  title: Schema.optional(text(200)),
  destinationUrl: Schema.optional(text(CAMPAIGN_URL_MAX)),
  scheduledAt: Schema.optional(IsoDateTime),
  sourceThreadId: Schema.optional(ThreadId),
  /**
   * Files already uploaded to cloud storage for this post, from the path in `mediaPaths` to the
   * public address it was given. A file listed here is never uploaded again.
   */
  uploadedMedia: Schema.Record(Schema.String, text(CAMPAIGN_URL_MAX)),
  createdBy: CampaignPostCreatedBy,
  approval: CampaignPostApproval,
  /** Keyed by platform. Only platforms that were tried have an entry. */
  publishResults: Schema.Record(Schema.String, CampaignPublishResult),
  /** What the person asked for the last time they pressed "request changes". */
  changeRequest: Schema.optional(text(CAMPAIGN_CAPTION_MAX)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CampaignPost = typeof CampaignPost.Type;

export const CampaignSummary = Schema.Struct({
  ...Campaign.fields,
  postCounts: Schema.Record(Schema.String, NonNegativeInt),
});
export type CampaignSummary = typeof CampaignSummary.Type;

export const CampaignPublishLogEntry = Schema.Struct({
  id: NonNegativeInt,
  postId: Id,
  platform: CampaignPlatform,
  /** The mode the post went out under. */
  mode: CampaignApprovalMode,
  /** "person", or "mode:<mode>" when the person's setting approved it. */
  approvedBy: Schema.String,
  result: Schema.Literals(["success", "failure"]),
  link: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  at: IsoDateTime,
});
export type CampaignPublishLogEntry = typeof CampaignPublishLogEntry.Type;

export const CampaignConnectorKind = Schema.Literals(["export", "marketing-engine"]);
export type CampaignConnectorKind = typeof CampaignConnectorKind.Type;

export const CampaignPublishingSwitch = Schema.Literals(["off", "on"]);
export type CampaignPublishingSwitch = typeof CampaignPublishingSwitch.Type;

export class CampaignError extends Schema.TaggedError<CampaignError>()("CampaignError", {
  reason: Schema.Literals([
    "not_found",
    "invalid",
    "not_allowed",
    "conflict",
    "unavailable",
    "storage",
  ]),
  message: TrimmedNonEmptyString,
}) {}

// RPC shapes

export const CampaignClientUpsertInput = Schema.Struct({
  /** Absent creates a client. */
  id: Schema.optional(Id),
  name: Name,
  brandNotes: text(CAMPAIGN_NOTES_MAX),
  doNotSay: Schema.Array(text(200)).check(Schema.isMaxLength(200)),
  publishingClientId: Schema.optional(Schema.NullOr(Id)),
  approvalMode: Schema.optional(CampaignApprovalMode),
  monthlySpendCapUsd: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});
export type CampaignClientUpsertInput = typeof CampaignClientUpsertInput.Type;

export const CampaignUpsertInput = Schema.Struct({
  id: Schema.optional(Id),
  clientId: Id,
  name: Name,
  /** Null clears the override. */
  approvalMode: Schema.optional(Schema.NullOr(CampaignApprovalMode)),
});
export type CampaignUpsertInput = typeof CampaignUpsertInput.Type;

/** What a person or an agent may write on a post. Status, approval and results are never input. */
export const CampaignPostContentInput = Schema.Struct({
  platforms: Schema.Array(CampaignPlatform).check(Schema.isMaxLength(CAMPAIGN_PLATFORMS.length)),
  captions: CampaignPostCaptions,
  mediaPaths: Schema.Array(text(CAMPAIGN_URL_MAX)).check(Schema.isMaxLength(CAMPAIGN_MEDIA_MAX)),
  mediaUrls: Schema.Array(text(CAMPAIGN_URL_MAX)).check(Schema.isMaxLength(CAMPAIGN_MEDIA_MAX)),
  title: Schema.optional(Schema.NullOr(text(200))),
  destinationUrl: Schema.optional(Schema.NullOr(text(CAMPAIGN_URL_MAX))),
  /** Null clears the proposed time. */
  scheduledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  sourceThreadId: Schema.optional(ThreadId),
});
export type CampaignPostContentInput = typeof CampaignPostContentInput.Type;

export const CampaignPostUpsertInput = Schema.Struct({
  /** Absent creates a post in `campaignId`. */
  id: Schema.optional(Id),
  campaignId: Id,
  ...CampaignPostContentInput.fields,
});
export type CampaignPostUpsertInput = typeof CampaignPostUpsertInput.Type;

export const CampaignConnectionState = Schema.Struct({
  connector: CampaignConnectorKind,
  baseUrl: Schema.String,
  /** The key itself never leaves the server. */
  hasKey: Schema.Boolean,
  publishing: CampaignPublishingSwitch,
  /** Folder an export goes to when the post has no source thread. Empty means none. */
  exportDirectory: Schema.String,
});
export type CampaignConnectionState = typeof CampaignConnectionState.Type;

export const CampaignConnectionSetInput = Schema.Struct({
  connector: Schema.optional(CampaignConnectorKind),
  baseUrl: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /** SENSITIVE. A value stores the key; null removes it; absent leaves it alone. */
  apiKey: Schema.optional(Schema.NullOr(AgentSecretValue)),
  exportDirectory: Schema.optional(text(CAMPAIGN_URL_MAX)),
});
export type CampaignConnectionSetInput = typeof CampaignConnectionSetInput.Type;

export const CampaignConnectionTestResult = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** Plain-word detail lines, one per line, such as each step of a self-check. */
  notes: Schema.optional(Schema.String),
});
export type CampaignConnectionTestResult = typeof CampaignConnectionTestResult.Type;

/**
 * Where files go to get a public address. Off until the owner switches it on. `s3` uploads to a
 * bucket the owner has; `server` has this server hand the files out itself at its own public address.
 */
export const CampaignStorageMode = Schema.Literals(["off", "s3", "server"]);
export type CampaignStorageMode = typeof CampaignStorageMode.Type;

/** Where a server in `server` mode hands out a post's files: `<public address>/api/campaign-media/<secret>/<name>`. */
export const CAMPAIGN_MEDIA_ROUTE_PREFIX = "/api/campaign-media";
/** True for an address a server made for a file, as opposed to a bucket's or one a person typed. */
export const isCampaignServerMediaLink = (url: string): boolean =>
  url.includes(`${CAMPAIGN_MEDIA_ROUTE_PREFIX}/`);

export const CampaignStorageState = Schema.Struct({
  mode: CampaignStorageMode,
  /** The S3-compatible service's address, for example https://<account>.r2.cloudflarestorage.com. */
  endpoint: Schema.String,
  region: Schema.String,
  bucket: Schema.String,
  /**
   * The address uploaded files are served from. In `server` mode it is this server's own public
   * address. Anyone with a file's link can open it.
   */
  publicBaseUrl: Schema.String,
  /** Put in front of every uploaded file's name, for example `campaigns/`. */
  prefix: Schema.String,
  /** The two keys themselves never leave the server. */
  hasCredentials: Schema.Boolean,
});
export type CampaignStorageState = typeof CampaignStorageState.Type;

export const CampaignStorageSetInput = Schema.Struct({
  mode: Schema.optional(CampaignStorageMode),
  endpoint: Schema.optional(text(CAMPAIGN_URL_MAX)),
  region: Schema.optional(text(64)),
  bucket: Schema.optional(text(255)),
  publicBaseUrl: Schema.optional(text(CAMPAIGN_URL_MAX)),
  prefix: Schema.optional(text(200)),
  /** SENSITIVE. A value stores the key; null removes it; absent leaves it alone. */
  accessKeyId: Schema.optional(Schema.NullOr(AgentSecretValue)),
  /** SENSITIVE. As `accessKeyId`. */
  secretAccessKey: Schema.optional(Schema.NullOr(AgentSecretValue)),
});
export type CampaignStorageSetInput = typeof CampaignStorageSetInput.Type;
// Generation: images and video made by a service the user connects. Nothing is spent unless a
// generator is chosen; the default is "none".

export const CampaignGenerationKind = Schema.Literals(["image", "video"]);
export type CampaignGenerationKind = typeof CampaignGenerationKind.Type;

/** The setting for one kind: a service, or "none". */
export const CampaignGeneratorKind = Schema.Literals([
  "none",
  "openrouter",
  "muapi",
  "fal",
  "marketing-engine",
  "local",
  "local-gpu",
]);
export type CampaignGeneratorKind = typeof CampaignGeneratorKind.Type;

/** A service that can be tried. */
export const CampaignGeneratorService = Schema.Literals([
  "openrouter",
  "muapi",
  "fal",
  "marketing-engine",
  "local",
  "local-gpu",
]);
export type CampaignGeneratorService = typeof CampaignGeneratorService.Type;

/** `needs-approval` waits for a person; the rest follow the job loop. */
export const CampaignGenerationStatus = Schema.Literals([
  "needs-approval",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type CampaignGenerationStatus = typeof CampaignGenerationStatus.Type;

export const CAMPAIGN_GENERATION_PROMPT_MAX = 4_000;
export const CAMPAIGN_GENERATION_ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
] as const;
export const CAMPAIGN_GENERATION_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const CAMPAIGN_GENERATION_DURATION_MIN = 1;
export const CAMPAIGN_GENERATION_DURATION_MAX = 30;

export const CampaignGenerationOptions = Schema.Struct({
  aspectRatio: Schema.optional(Schema.Literals(CAMPAIGN_GENERATION_ASPECT_RATIOS)),
  /** Video only. */
  durationSeconds: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({
        minimum: CAMPAIGN_GENERATION_DURATION_MIN,
        maximum: CAMPAIGN_GENERATION_DURATION_MAX,
      }),
    ),
  ),
  resolution: Schema.optional(Schema.Literals(CAMPAIGN_GENERATION_RESOLUTIONS)),
  generateAudio: Schema.optional(Schema.Boolean),
  /** Video only. An https address, or an image file in the source thread's folder. */
  firstFrame: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /**
   * Video only. Starts from the first picture of a finished image job instead of naming a file. It
   * is only a way to ask: the server swaps it for that picture's path and never stores it.
   */
  firstFrameJobId: Schema.optional(Id),
});
export type CampaignGenerationOptions = typeof CampaignGenerationOptions.Type;

export const CampaignGenerationRequestedBy = CampaignPostCreatedBy;

/**
 * These three shapes are written out as interfaces on purpose. They ride on `campaigns.mutate` and
 * the board stream, and `WsRpcGroup` is at the size TypeScript can still check (see AGENTS.md):
 * letting TypeScript infer their full structure there tips the server's route layer into `any`.
 */
export interface CampaignGenerationJob {
  readonly id: string;
  readonly clientId: string;
  readonly campaignId?: string | undefined;
  readonly kind: CampaignGenerationKind;
  readonly connector: CampaignGeneratorService;
  readonly model: string;
  readonly prompt: string;
  readonly options: CampaignGenerationOptions;
  readonly status: CampaignGenerationStatus;
  /** Null when the cost is unknown; the explicit allowance is reserved instead. */
  readonly estimatedUsd: number | null;
  readonly estimateNote: string;
  readonly reservedUsd?: number | undefined;
  readonly allowanceUsd?: number | undefined;
  readonly requestKey?: string | undefined;
  readonly submissionState?: "not-submitted" | "submitted" | "uncertain" | undefined;
  /** Files in the source thread's folder, relative to it. */
  readonly resultPaths: ReadonlyArray<string>;
  readonly error?: string | undefined;
  /** Why a queued job has not started yet: the card is busy, or it is not time. */
  readonly waitingNote?: string | undefined;
  readonly requestedBy: CampaignPostCreatedBy;
  readonly sourceThreadId?: ThreadId | undefined;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
export const CampaignGenerationJob: Schema.Codec<CampaignGenerationJob, unknown> = Schema.Struct({
  id: Id,
  clientId: Id,
  campaignId: Schema.optional(Id),
  kind: CampaignGenerationKind,
  connector: CampaignGeneratorService,
  model: Schema.String,
  prompt: Schema.String,
  options: CampaignGenerationOptions,
  status: CampaignGenerationStatus,
  /** Null when the cost is unknown; the explicit allowance is reserved instead. */
  estimatedUsd: Schema.NullOr(Schema.Number),
  estimateNote: Schema.String,
  reservedUsd: Schema.optional(Schema.Number),
  allowanceUsd: Schema.optional(Schema.Number),
  requestKey: Schema.optional(text(200)),
  submissionState: Schema.optional(Schema.Literals(["not-submitted", "submitted", "uncertain"])),
  /** Files in the source thread's folder, relative to it. */
  resultPaths: Schema.Array(text(CAMPAIGN_URL_MAX)),
  error: Schema.optional(Schema.String),
  waitingNote: Schema.optional(Schema.String),
  requestedBy: CampaignGenerationRequestedBy,
  sourceThreadId: Schema.optional(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const CampaignGenerationStartInput = Schema.Struct({
  connector: Schema.optional(CampaignGeneratorService),
  model: Schema.optional(text(200)),
  forceApproval: Schema.optional(Schema.Boolean),
  allowanceUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  requestKey: Schema.optional(text(200)),
  kind: CampaignGenerationKind,
  clientId: Id,
  campaignId: Schema.optional(Id),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(CAMPAIGN_GENERATION_PROMPT_MAX)),
  options: CampaignGenerationOptions,
  sourceThreadId: Schema.optional(ThreadId),
});
export type CampaignGenerationStartInput = typeof CampaignGenerationStartInput.Type;

export const CampaignGenerationSettingsInput = Schema.Struct({
  imageGenerator: Schema.optional(CampaignGeneratorKind),
  videoGenerator: Schema.optional(CampaignGeneratorKind),
  imageModel: Schema.optional(text(200)),
  videoModel: Schema.optional(text(200)),
  localBaseUrl: Schema.optional(text(CAMPAIGN_URL_MAX)),
  localModel: Schema.optional(text(200)),
  /** The program that runs the image script on this computer's graphics card. Empty finds one. */
  localGpuPython: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /** A preset id, or the folder of a diffusers model. Empty uses the small preset. */
  localGpuModel: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /** A video preset id. Empty uses the default video model. */
  localGpuVideoModel: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /** Where downloaded models are kept. Empty uses ~/.codewrench/localgen/models. */
  localGpuModelsDir: Schema.optional(text(CAMPAIGN_URL_MAX)),
  /** What a graphics-card job does when its model does not fit the free memory. */
  localGpuWhenBusy: Schema.optional(Schema.Literals(["fallback", "wait"])),
  /** Local clock times "HH:MM", or both empty for any time. */
  localGpuWindowStart: Schema.optional(text(5)),
  localGpuWindowEnd: Schema.optional(text(5)),
  /** SENSITIVE. A value stores the OpenRouter key; null removes it; absent leaves it alone. */
  openRouterKey: Schema.optional(Schema.NullOr(AgentSecretValue)),
  /** SENSITIVE. A value stores the MuAPI key; null removes it; absent leaves it alone. */
  muapiKey: Schema.optional(Schema.NullOr(AgentSecretValue)),
  /** SENSITIVE. A value stores the fal.ai key; null removes it; absent leaves it alone. */
  falKey: Schema.optional(Schema.NullOr(AgentSecretValue)),
});
export type CampaignGenerationSettingsInput = typeof CampaignGenerationSettingsInput.Type;

export interface CampaignGenerationSettings {
  readonly imageGenerator: CampaignGeneratorKind;
  readonly videoGenerator: CampaignGeneratorKind;
  /** The key itself never leaves the server. */
  readonly hasOpenRouterKey: boolean;
  readonly hasMuapiKey: boolean;
  readonly hasFalKey: boolean;
  readonly localBaseUrl: string;
  readonly models: { readonly image: string; readonly video: string; readonly local: string };
  /** This computer's graphics card: what is set, with empty meaning "use the default". */
  readonly localGpu: {
    readonly python: string;
    readonly model: string;
    readonly videoModel: string;
    readonly modelsDir: string;
    readonly whenBusy: "fallback" | "wait";
    readonly windowStart: string;
    readonly windowEnd: string;
  };
}
export const CampaignGenerationSettings: Schema.Codec<CampaignGenerationSettings, unknown> =
  Schema.Struct({
    imageGenerator: CampaignGeneratorKind,
    videoGenerator: CampaignGeneratorKind,
    /** The key itself never leaves the server. */
    hasOpenRouterKey: Schema.Boolean,
    hasMuapiKey: Schema.Boolean,
    hasFalKey: Schema.Boolean,
    localBaseUrl: Schema.String,
    models: Schema.Struct({
      image: Schema.String,
      video: Schema.String,
      local: Schema.String,
    }),
    localGpu: Schema.Struct({
      python: Schema.String,
      model: Schema.String,
      videoModel: Schema.String,
      modelsDir: Schema.String,
      whenBusy: Schema.Literals(["fallback", "wait"]),
      windowStart: Schema.String,
      windowEnd: Schema.String,
    }),
  });

export const CampaignGenerationSpend = Schema.Struct({
  clientId: Id,
  capUsd: Schema.NullOr(Schema.Number),
  usedUsd: Schema.Number,
});
export type CampaignGenerationSpend = typeof CampaignGenerationSpend.Type;

export interface CampaignGenerationBoard {
  /** Recent jobs for the selected campaign's client, or the latest overall when none is selected. */
  readonly jobs: ReadonlyArray<CampaignGenerationJob>;
  readonly settings: CampaignGenerationSettings;
  readonly spend: ReadonlyArray<CampaignGenerationSpend>;
}
export const CampaignGenerationBoard: Schema.Codec<CampaignGenerationBoard, unknown> =
  Schema.Struct({
    /** Recent jobs for the selected campaign's client, or the latest overall when none is selected. */
    jobs: Schema.Array(CampaignGenerationJob),
    settings: CampaignGenerationSettings,
    spend: Schema.Array(CampaignGenerationSpend),
  });

/**
 * Everything a person does with campaigns, in one call. `post.save` and `post.submit` need the
 * operate scope and never approve anything on their own; every other command (approve, reject,
 * publish, retry, delete, a mode on a client or campaign, the publishing connection) needs the
 * owner's access scope, which the server checks per command.
 */
const postId = { postId: Id } as const;
export const CampaignCommand = Schema.Union([
  Schema.Struct({ command: Schema.Literal("generation.reconcile"), jobId: Id, providerJobId: Id }),
  StudioCommand,
  Schema.Struct({ command: Schema.Literal("client.upsert"), client: CampaignClientUpsertInput }),
  Schema.Struct({ command: Schema.Literal("client.delete"), id: Id }),
  Schema.Struct({ command: Schema.Literal("campaign.upsert"), campaign: CampaignUpsertInput }),
  Schema.Struct({ command: Schema.Literal("campaign.delete"), id: Id }),
  Schema.Struct({ command: Schema.Literal("post.save"), post: CampaignPostUpsertInput }),
  Schema.Struct({ command: Schema.Literal("post.submit"), ...postId }),
  Schema.Struct({
    command: Schema.Literal("post.approve"),
    ...postId,
    /** Replaces the proposed time. A future time schedules the post; otherwise it is due at once. */
    scheduledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  }),
  Schema.Struct({
    command: Schema.Literal("post.requestChanges"),
    ...postId,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(CAMPAIGN_CAPTION_MAX)),
  }),
  Schema.Struct({ command: Schema.Literal("post.reject"), ...postId }),
  Schema.Struct({ command: Schema.Literal("post.publishNow"), ...postId }),
  Schema.Struct({ command: Schema.Literal("post.retry"), ...postId }),
  Schema.Struct({ command: Schema.Literal("post.delete"), ...postId }),
  Schema.Struct({
    command: Schema.Literal("connection.set"),
    connection: CampaignConnectionSetInput,
  }),
  Schema.Struct({
    command: Schema.Literal("connection.test"),
    connector: Schema.optional(CampaignConnectorKind),
  }),
  Schema.Struct({ command: Schema.Literal("storage.set"), storage: CampaignStorageSetInput }),
  /** Uploads a tiny file, checks its public address answers, and deletes it again. */
  Schema.Struct({ command: Schema.Literal("storage.test") }),
  /** Uploads the post's files to cloud storage and records their public addresses, without publishing. */
  Schema.Struct({ command: Schema.Literal("post.uploadMedia"), ...postId }),
  /** Stops this server sharing the post's files: its links stop working and are taken off the post. */
  Schema.Struct({ command: Schema.Literal("post.revokeMedia"), ...postId }),
  Schema.Struct({
    command: Schema.Literal("generation.start"),
    ...CampaignGenerationStartInput.fields,
  }),
  Schema.Struct({
    command: Schema.Literals(["generation.approve", "generation.cancel"]),
    jobId: Id,
  }),
  Schema.Struct({
    command: Schema.Literal("generation.settings.set"),
    settings: CampaignGenerationSettingsInput,
  }),
  Schema.Struct({
    command: Schema.Literal("generation.test"),
    generator: CampaignGeneratorService,
    /** `download` fetches the chosen model; only "local-gpu" has one. Absent is a plain check. */
    action: Schema.optional(Schema.Literal("download")),
    /** Which of the graphics card's models to check or fetch. Absent means the image model. */
    kind: Schema.optional(CampaignGenerationKind),
  }),
]);
export type CampaignCommand = typeof CampaignCommand.Type;

export const CampaignCommandResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("studio"), studio: ContentStudio }),
  Schema.Struct({ kind: Schema.Literal("client"), client: CampaignClient }),
  Schema.Struct({ kind: Schema.Literal("campaign"), campaign: Campaign }),
  Schema.Struct({ kind: Schema.Literal("post"), post: CampaignPost }),
  Schema.Struct({ kind: Schema.Literal("deleted"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("connection"), connection: CampaignConnectionState }),
  Schema.Struct({ kind: Schema.Literal("connectionTest"), result: CampaignConnectionTestResult }),
  Schema.Struct({ kind: Schema.Literal("storage"), storage: CampaignStorageState }),
  Schema.Struct({ kind: Schema.Literal("storageTest"), result: CampaignConnectionTestResult }),
  Schema.Struct({ kind: Schema.Literal("generationJob"), job: CampaignGenerationJob }),
  Schema.Struct({
    kind: Schema.Literal("generationSettings"),
    settings: CampaignGenerationSettings,
  }),
]);
export type CampaignCommandResult = typeof CampaignCommandResult.Type;

export const CampaignBoardInput = Schema.Struct({
  /** The campaign whose posts to include. Absent sends clients and campaigns only. */
  campaignId: Schema.optional(Id),
});
export type CampaignBoardInput = typeof CampaignBoardInput.Type;

/**
 * Everything a campaigns view shows, sent on subscribe and again after every change, so one
 * subscription is both the first read and the live feed.
 */
export const CampaignBoard = Schema.Struct({
  studio: Schema.optional(Schema.NullOr(ContentStudio)),
  revision: NonNegativeInt,
  clients: Schema.Array(CampaignClient),
  campaigns: Schema.Array(CampaignSummary),
  connection: CampaignConnectionState,
  /** Cloud storage for public file links. */
  storage: CampaignStorageState,
  /** Posts of the requested campaign. */
  posts: Schema.Array(CampaignPost),
  /** Every publish attempt for those posts, oldest first. */
  log: Schema.Array(CampaignPublishLogEntry),
  generation: CampaignGenerationBoard,
});
export type CampaignBoard = typeof CampaignBoard.Type;

// What the transport carries. The RPC group is at the size TypeScript can check, and a schema's
// inferred type is far heavier than its plain shape, so the two campaign calls take these flat
// codecs. Decoding and encoding are unchanged.
export const CampaignBoardWire: Schema.Codec<CampaignBoard, unknown> = CampaignBoard;
/**
 * A command as the transport sees it. `CampaignCommand` is a union with one member per action,
 * and the RPC types distribute over a payload union, which is what took the group past the size
 * TypeScript can check. This single shape carries the same value: the schema below still decodes
 * a full `CampaignCommand`, and the server reads it back as one with `asCampaignCommand`.
 */
export interface CampaignCommandEnvelope {
  readonly command: CampaignCommand["command"];
  readonly [field: string]: unknown;
}
export const CampaignCommandWire: Schema.Codec<CampaignCommandEnvelope, unknown> =
  CampaignCommand as unknown as Schema.Codec<CampaignCommandEnvelope, unknown>;
/** The decoded payload of `campaigns.mutate` is always a `CampaignCommand`; see the envelope. */
export const asCampaignCommand = (envelope: CampaignCommandEnvelope): CampaignCommand =>
  envelope as unknown as CampaignCommand;
export const CampaignCommandResultWire: Schema.Codec<CampaignCommandResult, unknown> =
  CampaignCommandResult;
