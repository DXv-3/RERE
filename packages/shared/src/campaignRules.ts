import {
  CAMPAIGN_PINTEREST_TITLE_MAX,
  type Campaign,
  type CampaignApprovalMode,
  type CampaignClient,
  type CampaignPlatform,
  type CampaignPost,
  type CampaignPostApproval,
  type CampaignPostStatus,
} from "@t3tools/contracts";

import { isWithinQuietHours, parseClockMinutes } from "./threadNotificationPolicy.ts";

/**
 * The rules for campaign posts, with no I/O. The server's store enforces them on every write and
 * the board reads them to decide which buttons to show, so both sides agree on who may do what.
 *
 * The one rule everything else serves: an agent can never approve a post. Whether an agent's
 * "this is ready" ends in a waiting card or an approved post is decided by the mode a person set.
 */

export type CampaignActor = "person" | "agent" | "system";

const PLATFORMS_THAT_NEED_MEDIA: ReadonlySet<CampaignPlatform> = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "pinterest",
]);

const platformNeedsMedia = (platform: CampaignPlatform): boolean =>
  PLATFORMS_THAT_NEED_MEDIA.has(platform);

const timeOf = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

export const effectiveMode = (
  client: Pick<CampaignClient, "approvalMode">,
  campaign: Pick<Campaign, "approvalMode">,
): CampaignApprovalMode => campaign.approvalMode ?? client.approvalMode;

export type SubmitOutcome =
  | { readonly status: "needs-approval"; readonly approval: null }
  | {
      readonly status: "approved" | "scheduled";
      readonly approval: {
        readonly by: "mode";
        readonly mode: CampaignApprovalMode;
        readonly at: string;
      };
    };

/**
 * What an agent's "this post is ready" produces. Under ask-first the post waits for a person. In
 * the other two modes the person's earlier choice approves it, and a future proposed time makes
 * it scheduled instead of due at once.
 */
export function nextStatusAfterSubmit(
  mode: CampaignApprovalMode,
  input: { readonly scheduledAt?: string | undefined; readonly now: string },
): SubmitOutcome {
  if (mode === "ask-first") return { status: "needs-approval", approval: null };
  const approval = { by: "mode" as const, mode, at: input.now };
  const at = timeOf(input.scheduledAt);
  const now = timeOf(input.now);
  return at !== null && now !== null && at > now
    ? { status: "scheduled", approval }
    : { status: "approved", approval };
}

/** A post a person approves is scheduled when its time is still ahead, else due at once. */
export function statusAfterPersonApproval(input: {
  readonly scheduledAt?: string | undefined;
  readonly now: string;
}): "approved" | "scheduled" {
  const at = timeOf(input.scheduledAt);
  const now = timeOf(input.now);
  return at !== null && now !== null && at > now ? "scheduled" : "approved";
}

const PERSON_TRANSITIONS: Readonly<Record<CampaignPostStatus, ReadonlyArray<CampaignPostStatus>>> =
  {
    draft: ["needs-approval", "approved", "scheduled", "rejected"],
    "needs-approval": ["draft", "approved", "scheduled", "rejected"],
    // Approving again with a new time keeps the post approved or scheduled.
    approved: ["draft", "approved", "scheduled", "rejected"],
    scheduled: ["draft", "approved", "scheduled", "rejected"],
    publishing: [],
    posted: [],
    // A retry goes back to approved; the person already approved this content.
    failed: ["draft", "approved", "scheduled", "rejected"],
    rejected: ["draft"],
  };

const AGENT_TRANSITIONS: Readonly<Record<CampaignPostStatus, ReadonlyArray<CampaignPostStatus>>> = {
  // Submit. What it becomes under a mode other than ask-first comes from `nextStatusAfterSubmit`.
  draft: ["needs-approval"],
  // Taking a submission back to change it.
  "needs-approval": ["draft"],
  approved: [],
  scheduled: [],
  publishing: [],
  posted: [],
  failed: [],
  rejected: [],
};

const SYSTEM_TRANSITIONS: Readonly<Record<CampaignPostStatus, ReadonlyArray<CampaignPostStatus>>> =
  {
    draft: [],
    "needs-approval": [],
    approved: ["publishing"],
    scheduled: ["publishing"],
    publishing: ["posted", "failed"],
    posted: [],
    failed: [],
    rejected: [],
  };

const TRANSITIONS: Readonly<
  Record<CampaignActor, Readonly<Record<CampaignPostStatus, ReadonlyArray<CampaignPostStatus>>>>
> = { person: PERSON_TRANSITIONS, agent: AGENT_TRANSITIONS, system: SYSTEM_TRANSITIONS };

export const canTransition = (
  from: CampaignPostStatus,
  to: CampaignPostStatus,
  actor: CampaignActor,
): boolean => TRANSITIONS[actor][from].includes(to);

/**
 * The status a post has after its content is edited, or null when the edit is refused. An edit
 * always drops a post back to a draft, which also drops any approval: what was approved is no
 * longer what would go out.
 */
export const statusAfterEdit = (
  status: CampaignPostStatus,
  actor: "person" | "agent",
): "draft" | null => (status === "draft" || canTransition(status, "draft", actor) ? "draft" : null);

/** The posts whose time has come. An approved post with no time is due at once. */
export function duePosts<Post extends Pick<CampaignPost, "status" | "scheduledAt">>(
  posts: ReadonlyArray<Post>,
  now: string,
): Post[] {
  const nowMs = timeOf(now);
  if (nowMs === null) return [];
  return posts.filter((post) => {
    if (post.status !== "approved" && post.status !== "scheduled") return false;
    const at = timeOf(post.scheduledAt);
    return at === null || at <= nowMs;
  });
}

/** The caption for one platform: its own when written, else the default. */
export function captionFor(
  post: Pick<CampaignPost, "captions">,
  platform: CampaignPlatform,
): string {
  const own = post.captions.byPlatform[platform];
  return own !== undefined && own.trim() !== "" ? own : post.captions.default;
}

/** Phrases from the list that the text contains, ignoring case. */
export function findDoNotSay(text: string, phrases: ReadonlyArray<string>): string[] {
  const haystack = text.toLowerCase();
  return phrases.filter((phrase) => {
    const needle = phrase.trim().toLowerCase();
    return needle !== "" && haystack.includes(needle);
  });
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * What stops a post from being submitted or approved, in words for the person or agent reading it.
 * Drafts may be incomplete; this is checked when a post claims to be ready.
 */
export function validateCampaignPost(
  post: Pick<
    CampaignPost,
    | "platforms"
    | "captions"
    | "mediaPaths"
    | "mediaUrls"
    | "title"
    | "destinationUrl"
    | "scheduledAt"
  >,
  options: { readonly doNotSay?: ReadonlyArray<string> } = {},
): string[] {
  const issues: string[] = [];
  if (post.platforms.length === 0) issues.push("Choose at least one platform.");
  if (post.scheduledAt !== undefined && timeOf(post.scheduledAt) === null) {
    issues.push("The proposed time is not a valid date and time.");
  }
  const mediaCount = post.mediaPaths.length + post.mediaUrls.length;
  for (const platform of post.platforms) {
    const caption = captionFor(post, platform);
    if (caption.trim() === "") issues.push(`Write a caption for ${platform}.`);
    for (const phrase of findDoNotSay(caption, options.doNotSay ?? [])) {
      issues.push(
        `The ${platform} caption says "${phrase}", which is on this client's do-not-say list.`,
      );
    }
    if (platformNeedsMedia(platform) && mediaCount === 0) {
      issues.push(`${platform} needs at least one image or video.`);
    }
  }
  if (post.platforms.includes("pinterest")) {
    const title = post.title?.trim() ?? "";
    if (title === "") issues.push("Pinterest needs a title.");
    else if (title.length > CAMPAIGN_PINTEREST_TITLE_MAX) {
      issues.push(`The Pinterest title is longer than ${CAMPAIGN_PINTEREST_TITLE_MAX} characters.`);
    }
    const destination = post.destinationUrl?.trim() ?? "";
    if (destination === "") issues.push("Pinterest needs a destination link.");
    else if (!isHttpUrl(destination))
      issues.push("The Pinterest destination link is not a web address.");
  }
  return issues;
}

/** Who approved a post, as the publish log records it. */
export const approvedByLabel = (approval: CampaignPostApproval): string =>
  approval === null ? "none" : approval.by === "person" ? "person" : `mode:${approval.mode}`;

// Generation spend

/** The part of a generation job the spend rules read. */
export interface GenerationSpendJob {
  readonly status: "needs-approval" | "queued" | "running" | "done" | "failed" | "cancelled";
  readonly estimatedUsd: number | null;
  readonly createdAt: string;
  /** True once the provider was asked, so a cancelled job may still have been charged. */
  readonly started: boolean;
}

/** The first moment of the UTC month that `nowIso` (an ISO 8601 UTC time) falls in. */
export const monthStartIso = (nowIso: string): string => `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;

/**
 * Whether a job counts against the month's limit: queued, running and done jobs do, and so does a
 * cancelled job the provider had already been asked for. Failed jobs, jobs waiting for approval and
 * jobs cancelled before they started do not.
 */
const countsAsGenerationSpend = (job: GenerationSpendJob): boolean =>
  job.status === "queued" ||
  job.status === "running" ||
  job.status === "done" ||
  (job.status === "cancelled" && job.started);

/** This month's estimated dollars for one client's jobs. A job with no estimate counts as $0. */
export const generationUsedUsd = (jobs: ReadonlyArray<GenerationSpendJob>, nowIso: string) => {
  const since = monthStartIso(nowIso);
  const total = jobs
    .filter((job) => job.createdAt >= since && countsAsGenerationSpend(job))
    .reduce((sum, job) => sum + (job.estimatedUsd ?? 0), 0);
  return Math.round(total * 1_000_000) / 1_000_000;
};

const usd = (value: number): string => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

export type GenerationSpendDecision =
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly message: string };

/**
 * The cap check done before a job starts. No cap means no limit. A job whose cost cannot be
 * estimated counts as $0 and says so, so a cap cannot stop what it cannot measure.
 */
export function checkGenerationSpend(input: {
  readonly clientName: string;
  readonly capUsd: number | null | undefined;
  readonly usedUsd: number;
  readonly estimatedUsd: number | null;
}): GenerationSpendDecision {
  const unknown =
    input.estimatedUsd === null
      ? "The cost of this job could not be estimated, so it counts as $0 against the monthly limit."
      : null;
  if (input.capUsd === null || input.capUsd === undefined) return { ok: true, note: unknown };
  const cost = input.estimatedUsd ?? 0;
  // A tiny tolerance so a job that lands exactly on the limit is not refused by float noise.
  if (input.usedUsd + cost > input.capUsd + 1e-9) {
    return {
      ok: false,
      message: `This would pass ${input.clientName}'s monthly limit of ${usd(input.capUsd)} (${usd(input.usedUsd)} used).`,
    };
  }
  return { ok: true, note: unknown };
}

export interface GenerationEstimateInput {
  readonly connector: "openrouter" | "muapi" | "fal" | "marketing-engine" | "local" | "local-gpu";
  readonly kind: "image" | "video";
  readonly model: string;
  readonly durationSeconds?: number | undefined;
}

export interface GenerationEstimate {
  readonly usd: number | null;
  readonly note: string;
}

/**
 * Per-second and per-image prices, only for models whose price can be sourced. Each entry needs a
 * comment naming where the number came from. It is empty on purpose: OpenRouter's model pages
 * show a price only through the account's own usage figure (`usage.cost`, checked 2026-10-06),
 * and the marketing engine and a local server have no published price list.
 */
const PRICE_TABLE: Readonly<
  Record<string, { readonly perSecondUsd?: number; readonly perImageUsd?: number }>
> = {};

export function estimateGenerationUsd(input: GenerationEstimateInput): GenerationEstimate {
  const entry = input.connector === "openrouter" ? PRICE_TABLE[input.model] : undefined;
  if (input.kind === "video" && entry?.perSecondUsd !== undefined && input.durationSeconds) {
    const total = entry.perSecondUsd * input.durationSeconds;
    return { usd: total, note: `About ${usd(total)} for ${input.durationSeconds} seconds.` };
  }
  if (input.kind === "image" && entry?.perImageUsd !== undefined) {
    return { usd: entry.perImageUsd, note: `About ${usd(entry.perImageUsd)} for one image.` };
  }
  if (input.connector === "muapi") {
    return { usd: null, note: "MuAPI charges per video; see its pricing page for this model." };
  }
  if (input.connector === "fal") {
    return {
      usd: null,
      note: "fal.ai charges per second of video; see the model's page for its rate.",
    };
  }
  if (input.connector === "local-gpu") return { usd: 0, note: "Runs on this computer." };
  if (input.connector === "local") {
    return { usd: 0, note: "Runs on your own server, so there is no charge from a provider." };
  }
  return {
    usd: null,
    note: "Cost unknown: no price is published for this model here. Check the provider's usage page.",
  };
}

/**
 * The image models "This Computer's GPU" offers, smallest first. All are open weights whose
 * licenses allow commercial use (checked 2026-10-07 on the model cards: the LCM card says MIT;
 * SDXL's is CreativeML Open RAIL++-M, royalty-free with use restrictions; FLUX.1 schnell's says
 * Apache-2.0; Z-Image Turbo's card says Apache-2.0. FLUX.1 dev is non-commercial and is not offered). `freeGb` is the free graphics
 * memory the script wants before it starts; `apps/server/resources/localgen/generate_image.py`
 * holds the same numbers and refuses when there is less.
 */
export const LOCAL_GPU_PRESETS = [
  {
    id: "lcm-dreamshaper-v7",
    label: "Small, fast (about 3 GB of free graphics memory)",
    license: "MIT",
    downloadGb: 4.3,
    freeGb: 3,
    longEdge: 768,
  },
  {
    id: "sdxl-base-1.0",
    label: "Better quality (about 6.5 GB of free graphics memory)",
    license: "CreativeML Open RAIL++-M",
    downloadGb: 6.9,
    freeGb: 6.5,
    longEdge: 1024,
  },
  {
    id: "flux-schnell",
    label: "Good for people (about 7.5 GB of free graphics memory)",
    license: "Apache-2.0",
    downloadGb: 33.7,
    freeGb: 7.5,
    longEdge: 1024,
  },
  {
    id: "z-image-turbo",
    label: "Best quality (about 9 GB of free graphics memory)",
    license: "Apache-2.0",
    downloadGb: 32.8,
    freeGb: 9,
    longEdge: 1024,
  },
] as const;
export const LOCAL_GPU_DEFAULT_PRESET = LOCAL_GPU_PRESETS[0].id;

/**
 * The video models "This Computer's GPU" offers. A video is made from a still image, which becomes
 * its first frame. Wan 2.2 TI2V 5B's model card says Apache-2.0 and that the makers claim no rights
 * over what is generated (checked 2026-10-07, huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers).
 * `apps/server/resources/localgen/generate_video.py` holds the same numbers and refuses when less
 * graphics memory is free. `freeGb` was measured for a 5 second clip.
 */
export const LOCAL_GPU_VIDEO_PRESETS = [
  {
    id: "wan22-ti2v-5b",
    label: "Wan 2.2 5B (about 7.5 GB of free graphics memory)",
    license: "Apache-2.0",
    downloadGb: 34.2,
    freeGb: 7.5,
    minSeconds: 3,
    maxSeconds: 5,
    /** Pixels in a "480p" picture; other shapes keep about this area. */
    pixelBudget: 640 * 640,
  },
] as const;
export const LOCAL_GPU_DEFAULT_VIDEO_PRESET = LOCAL_GPU_VIDEO_PRESETS[0].id;

/** How long a graphics-card job may wait for room or for its night window before it gives up. */
export const LOCAL_GPU_WAIT_LIMIT_MS = 24 * 60 * 60 * 1000;

/** True when the two window times are both empty, or both valid "HH:MM" clock times. */
export function isValidLocalGpuWindow(start: string, end: string): boolean {
  const [s, e] = [start.trim(), end.trim()];
  if (s === "" && e === "") return true;
  return parseClockMinutes(s) !== null && parseClockMinutes(e) !== null;
}

/**
 * Whether a graphics-card job may start at `minuteOfDay` (minutes after local midnight). Two empty
 * or unreadable times mean any time. A window that ends before it starts crosses midnight.
 */
export function localGpuWindowOpen(input: {
  readonly start: string;
  readonly end: string;
  readonly minuteOfDay: number;
}): boolean {
  const startMinute = parseClockMinutes(input.start.trim());
  const endMinute = parseClockMinutes(input.end.trim());
  if (startMinute === null || endMinute === null || startMinute === endMinute) return true;
  return isWithinQuietHours(input.minuteOfDay, { startMinute, endMinute });
}

/** The note on a job held back by the window, or null when it may start now. */
export function localGpuWindowNote(input: {
  readonly start: string;
  readonly end: string;
  readonly minuteOfDay: number;
}): string | null {
  return localGpuWindowOpen(input) ? null : `Scheduled for tonight after ${input.start.trim()}.`;
}

/** The note on a job whose model does not fit the free graphics memory yet. */
export function localGpuBusyNote(freeGb: number, needGb: number): string {
  return `Waiting for the graphics card: ${freeGb.toFixed(1)} GB free, this model needs ${needGb.toFixed(1)} GB.`;
}

/** True once a job has waited past the limit. `since` is when it first started waiting. */
export function localGpuWaitExpired(since: string, nowIso: string): boolean {
  const waited = Date.parse(nowIso) - Date.parse(since);
  return Number.isFinite(waited) && waited > LOCAL_GPU_WAIT_LIMIT_MS;
}
