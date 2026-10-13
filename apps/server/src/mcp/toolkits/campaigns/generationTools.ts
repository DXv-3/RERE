import {
  CAMPAIGN_GENERATION_ASPECT_RATIOS,
  CAMPAIGN_GENERATION_DURATION_MAX,
  CAMPAIGN_GENERATION_DURATION_MIN,
  CAMPAIGN_GENERATION_PROMPT_MAX,
  CAMPAIGN_GENERATION_RESOLUTIONS,
  CampaignError,
  CampaignGenerationKind,
  CampaignGenerationStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as GenerationService from "../../../campaigns/generation/GenerationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  GenerationService.GenerationService,
];

/** The most jobs one status listing returns. */
export const GENERATION_STATUS_LIST_MAX = 10;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const GenerationJobResult = Schema.Struct({
  jobId: Schema.String,
  kind: CampaignGenerationKind,
  status: CampaignGenerationStatus,
  model: Schema.String,
  /** Null when the cost could not be estimated. */
  estimatedUsd: Schema.NullOr(Schema.Number),
  estimateNote: Schema.String,
  reservedUsd: Schema.optional(Schema.Number),
  allowanceUsd: Schema.optional(Schema.Number),
  submissionState: Schema.optional(Schema.Literals(["not-submitted", "submitted", "uncertain"])),
  /** Files in this thread's folder, once the job is done. Look at them with media_inspect. */
  resultPaths: Schema.Array(Schema.String),
  error: Schema.optional(Schema.String),
  /** In words: what happens now and what to do next. */
  outcome: Schema.String,
});
export type GenerationJobResult = typeof GenerationJobResult.Type;

export const GenerationStatusResult = Schema.Struct({
  jobs: Schema.Array(GenerationJobResult),
});
export type GenerationStatusResult = typeof GenerationStatusResult.Type;

const CommonFields = {
  allowanceUsd: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0)).annotate({
      description:
        "Propose a positive dollar allowance when pricing is unknown. This always creates a job waiting for a person to approve on the campaign board, even in automatic modes. It is a reservation, not a provider billing ceiling. Omit when a known price or free local generator is available.",
    }),
  ),
  clientId: Id.annotate({
    description: "The client the picture or video is for, from campaign_list.",
  }),
  campaignId: Schema.optional(
    Id.annotate({
      description: "The campaign it belongs to, from campaign_list. Leave out if unsorted.",
    }),
  ),
  prompt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CAMPAIGN_GENERATION_PROMPT_MAX),
  ).annotate({
    description:
      "What to make, in plain words: subject, setting, light, style. Keep the client's brand notes and do-not-say list in mind.",
  }),
  aspectRatio: Schema.optional(
    Schema.Literals(CAMPAIGN_GENERATION_ASPECT_RATIOS).annotate({
      description:
        "Shape of the frame. 9:16 for reels, TikTok and Stories; 1:1 or 4:3 for feed posts.",
    }),
  ),
};

const RULES =
  "Tell the person the cost estimate in your reply before or as you start (estimatedUsd and estimateNote in the result; if the cost is unknown say so). Make at most one per request unless the person asked for more. If it fails, do not start it again in a loop: tell the person why and ask. If pricing is unknown, propose allowanceUsd; a person must approve that allowance on the campaign board before any generation call. Never represent a proposed allowance as already approved. Client monthly and campaign plan limits can refuse the reservation.";

const MediaGenerateImageTool = Tool.make("media_generate_image", {
  description: `Make an image with the image generator the person set up in Settings. It runs in the background: you get a message in this conversation with the file path when it is done, then look at it with media_inspect and attach it to a post with campaign_post_save (mediaPaths). If the client's or campaign's approval mode is ask-first, the job is only created and a person has to approve the spend on the campaign board; nothing is spent until they do. ${RULES}`,
  parameters: Schema.Struct(CommonFields),
  success: GenerationJobResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Generate an image")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MediaGenerateVideoTool = Tool.make("media_generate_video", {
  description: `Make a short video with the video generator the person set up in Settings. A chat subscription cannot make video, so this fails with a plain message when no generator is set up. It runs in the background and can take several minutes: you get a message in this conversation with the file path when it is done. Give a first-frame image (an https link, or an image file in this thread's folder) to animate a picture. With this computer's own graphics card (when the person chose it in Settings) a still image is required: it only makes video from a picture, and a web link is not used: first make or find the picture (usually media_generate_image, then look at it with media_inspect), then pass its path as firstFrame, or pass the finished image job's id as fromJobId. Those clips are 3 to 5 seconds, wait for the card to be free and are best run overnight, so tell the person it may take a while. If the client's or campaign's approval mode is ask-first, the job is only created and a person has to approve the spend on the campaign board; nothing is spent until they do. ${RULES}`,
  parameters: Schema.Struct({
    ...CommonFields,
    durationSeconds: Schema.optional(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isBetween({
          minimum: CAMPAIGN_GENERATION_DURATION_MIN,
          maximum: CAMPAIGN_GENERATION_DURATION_MAX,
        }),
      ).annotate({
        description: "Length in seconds. Models differ; omit to use the model's supported default.",
      }),
    ),
    resolution: Schema.optional(
      Schema.Literals(CAMPAIGN_GENERATION_RESOLUTIONS).annotate({
        description: "Use a supported model resolution, or omit for its default.",
      }),
    ),
    generateAudio: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Only models with an audio toggle accept this. Omit for MuAPI: its source audio is provider-controlled and can be muted during assembly.",
      }),
    ),
    firstFrame: Schema.optional(
      Schema.String.check(Schema.isMaxLength(2_048)).annotate({
        description:
          "An https link or a png, jpg or webp file in this thread's folder, used as the first frame.",
      }),
    ),
    fromJobId: Schema.optional(
      Id.annotate({
        description:
          "Instead of firstFrame: the jobId of a finished image you made with media_generate_image. Its picture becomes the first frame.",
      }),
    ),
  }),
  success: GenerationJobResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Generate a video")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MediaGenerationStatusTool = Tool.make("media_generation_status", {
  description:
    "Check a generation job you started, or list your most recent ones. Use it instead of starting another job when you are unsure whether the first one worked. A finished job lists the files it made, in this thread's folder.",
  parameters: Schema.Struct({
    jobId: Schema.optional(
      Id.annotate({
        description:
          "A jobId from media_generate_image or media_generate_video. Leave out to list recent jobs.",
      }),
    ),
  }),
  success: GenerationStatusResult,
  failure: CampaignError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check a generation job")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MediaGenerationToolkit = Toolkit.make(
  MediaGenerateImageTool,
  MediaGenerateVideoTool,
  MediaGenerationStatusTool,
);
