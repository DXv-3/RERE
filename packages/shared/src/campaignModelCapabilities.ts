import type { CampaignGenerationKind, CampaignGenerationOptions } from "@t3tools/contracts";

/** A deliberately supported subset, verified from the linked input schemas on 2026-10-08.
 * Pricing stays unknown: provider credits and option-dependent rates are not dollar quotes.
 */
export interface CampaignModelCapability {
  readonly connector: "fal" | "muapi";
  readonly model: string;
  readonly label: string;
  readonly kind: CampaignGenerationKind;
  readonly firstFrame: "required" | "unsupported";
  readonly audio: "toggle" | "provider-default" | "unsupported";
  readonly durations: ReadonlyArray<number>;
  readonly resolutions: ReadonlyArray<NonNullable<CampaignGenerationOptions["resolution"]>>;
  readonly aspectRatios: ReadonlyArray<NonNullable<CampaignGenerationOptions["aspectRatio"]>>;
  readonly defaultDuration?: number;
  readonly defaultResolution?: NonNullable<CampaignGenerationOptions["resolution"]>;
  readonly defaultAspectRatio?: NonNullable<CampaignGenerationOptions["aspectRatio"]>;
  readonly maxPromptLength: number;
  readonly documentationUrl: string;
}

const falVeo = (
  model: string,
  label: string,
  firstFrame: "required" | "unsupported",
): CampaignModelCapability => ({
  connector: "fal",
  model,
  label,
  kind: "video",
  firstFrame,
  audio: "toggle",
  durations: [4, 6, 8],
  resolutions: ["720p", "1080p"],
  aspectRatios: ["16:9", "9:16"],
  defaultDuration: 8,
  defaultResolution: "720p",
  defaultAspectRatio: "16:9",
  maxPromptLength: 4000,
  documentationUrl: `https://fal.ai/models/${model}/api`,
});
const muVeo = (
  model: string,
  label: string,
  firstFrame: "required" | "unsupported",
): CampaignModelCapability => ({
  connector: "muapi",
  model,
  label,
  kind: "video",
  firstFrame,
  audio: "provider-default",
  durations: [8],
  resolutions: ["720p", "1080p"],
  aspectRatios: ["16:9", "9:16"],
  defaultDuration: 8,
  defaultResolution: "720p",
  defaultAspectRatio: "16:9",
  maxPromptLength: 4000,
  documentationUrl: `https://muapi.ai/playground/${model}/llms.txt`,
});
const kling = (tier: "pro" | "standard"): CampaignModelCapability => ({
  connector: "fal",
  model: `fal-ai/kling-video/v3/${tier}/image-to-video`,
  label: `Kling 3 ${tier}`,
  kind: "video",
  firstFrame: "required",
  audio: "toggle",
  durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  resolutions: [],
  aspectRatios: [],
  defaultDuration: 5,
  maxPromptLength: 2500,
  documentationUrl: `https://fal.ai/models/fal-ai/kling-video/v3/${tier}/image-to-video/api`,
});
export const CAMPAIGN_MODEL_CAPABILITIES: ReadonlyArray<CampaignModelCapability> = [
  falVeo("fal-ai/veo3.1", "Veo 3.1 · text", "unsupported"),
  falVeo("fal-ai/veo3.1/image-to-video", "Veo 3.1 · image", "required"),
  falVeo("fal-ai/veo3.1/lite/image-to-video", "Veo 3.1 Lite · image", "required"),
  kling("pro"),
  kling("standard"),
  ...(
    ["bytedance/seedance-2.0/image-to-video", "bytedance/seedance-2.0/fast/image-to-video"] as const
  ).map((model): CampaignModelCapability => ({
    connector: "fal",
    model,
    label: model.includes("fast") ? "Seedance 2 Fast" : "Seedance 2",
    kind: "video",
    firstFrame: "required",
    audio: "toggle",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    resolutions: model.includes("fast") ? ["480p", "720p"] : ["480p", "720p", "1080p"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultDuration: 5,
    defaultResolution: "720p",
    maxPromptLength: 4000,
    documentationUrl: `https://fal.ai/models/${model}/api`,
  })),
  muVeo("veo3.1-text-to-video", "Veo 3.1 · text", "unsupported"),
  muVeo("veo3.1-image-to-video", "Veo 3.1 · image", "required"),
  muVeo("veo3.1-fast-text-to-video", "Veo 3.1 Fast · text", "unsupported"),
  muVeo("veo3.1-fast-image-to-video", "Veo 3.1 Fast · image", "required"),
  {
    connector: "muapi",
    model: "runway-image-to-video",
    label: "Runway · image",
    kind: "video",
    firstFrame: "required",
    audio: "unsupported",
    durations: [5, 8],
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    defaultDuration: 5,
    defaultResolution: "720p",
    defaultAspectRatio: "16:9",
    maxPromptLength: 4000,
    documentationUrl: "https://muapi.ai/playground/runway-image-to-video/llms.txt",
  },
  {
    connector: "muapi",
    model: "minimax-hailuo-02-pro-i2v",
    label: "Hailuo 02 Pro · image",
    kind: "video",
    firstFrame: "required",
    audio: "unsupported",
    durations: [6],
    resolutions: ["1080p"],
    aspectRatios: [],
    defaultDuration: 6,
    defaultResolution: "1080p",
    maxPromptLength: 4000,
    documentationUrl: "https://muapi.ai/playground/minimax-hailuo-02-pro-i2v/llms.txt",
  },
  ...(["fal", "muapi"] as const).map((connector): CampaignModelCapability => ({
    connector,
    model: connector === "fal" ? "fal-ai/flux/dev" : "flux-dev",
    label: "FLUX Dev",
    kind: "image",
    firstFrame: "unsupported",
    audio: "unsupported",
    durations: [],
    resolutions: [],
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    defaultAspectRatio: "1:1",
    maxPromptLength: 3000,
    documentationUrl:
      connector === "fal"
        ? "https://fal.ai/models/fal-ai/flux/dev/api"
        : "https://muapi.ai/playground/flux-dev/llms.txt",
  })),
];

export const getCampaignModelCapability = (connector: string, model: string) =>
  CAMPAIGN_MODEL_CAPABILITIES.find(
    (entry) => entry.connector === connector && entry.model === model,
  );

/** Reject unsupported controls instead of silently changing the approved generation request. */
export function campaignModelOptionsError(
  capability: CampaignModelCapability,
  kind: CampaignGenerationKind,
  options: CampaignGenerationOptions,
): string | null {
  if (capability.kind !== kind) return `${capability.model} makes ${capability.kind}, not ${kind}.`;
  const hasFrame = Boolean(options.firstFrame?.trim() || options.firstFrameJobId);
  if (capability.firstFrame === "required" && !hasFrame)
    return `${capability.model} needs a starting image.`;
  if (capability.firstFrame === "unsupported" && hasFrame)
    return `${capability.model} does not accept a starting image.`;
  if (options.generateAudio !== undefined && capability.audio !== "toggle") {
    return `${capability.model} has no audio toggle. Leave audio unset; mute the result during assembly if needed.`;
  }
  if (
    options.durationSeconds !== undefined &&
    !capability.durations.includes(options.durationSeconds)
  )
    return `${capability.model} accepts durations of ${capability.durations.join(", ")} seconds.`;
  if (options.resolution !== undefined && !capability.resolutions.includes(options.resolution))
    return `${capability.model} does not accept that resolution control.`;
  if (options.aspectRatio !== undefined && !capability.aspectRatios.includes(options.aspectRatio))
    return `${capability.model} does not accept that aspect ratio control.`;
  if (
    capability.model === "runway-image-to-video" &&
    options.durationSeconds === 8 &&
    options.resolution === "1080p"
  )
    return "Runway's eight-second clips require 720p.";
  return null;
}

/** Both FLUX APIs accept explicit dimensions, not a generic aspect_ratio field. */
export const campaignImageDimensions = (aspectRatio: CampaignGenerationOptions["aspectRatio"]) => {
  switch (aspectRatio) {
    case "16:9":
      return { width: 1024, height: 576 };
    case "9:16":
      return { width: 576, height: 1024 };
    case "4:3":
      return { width: 1024, height: 768 };
    case "3:4":
      return { width: 768, height: 1024 };
    default:
      return { width: 1024, height: 1024 };
  }
};
