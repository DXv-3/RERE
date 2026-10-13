import {
  campaignModelOptionsError,
  getCampaignModelCapability,
} from "@t3tools/shared/campaignModelCapabilities";
import {
  CAMPAIGN_GENERATION_DURATION_MAX,
  CAMPAIGN_GENERATION_DURATION_MIN,
  CAMPAIGN_GENERATION_PROMPT_MAX,
  type CampaignGenerationJob,
  type CampaignGenerationKind,
  type CampaignGenerationOptions,
  type CampaignGenerationSettings,
  type CampaignGenerationSpend,
  type CampaignGeneratorKind,
} from "@t3tools/contracts";
import {
  checkGenerationSpend,
  estimateGenerationUsd,
  LOCAL_GPU_DEFAULT_PRESET,
  LOCAL_GPU_DEFAULT_VIDEO_PRESET,
  LOCAL_GPU_VIDEO_PRESETS,
  monthStartIso,
} from "@t3tools/shared/campaignRules";

/**
 * What the generation screens decide, with no React and no I/O: which words and buttons a job
 * gets, what the form may send, and how the month's spend reads. The spend rules themselves live
 * in `@t3tools/shared/campaignRules`; these helpers only ask them. Nothing here invents a price.
 */

export const GENERATOR_LABEL: Readonly<Record<CampaignGeneratorKind, string>> = {
  none: "None",
  openrouter: "OpenRouter",
  muapi: "MuAPI",
  fal: "fal.ai",
  "marketing-engine": "Savage Digital Solutions Marketing Engine",
  local: "A Local Server",
  "local-gpu": "This Computer's GPU",
};

export const KIND_LABEL: Readonly<Record<CampaignGenerationKind, string>> = {
  image: "Image",
  video: "Video",
};

const GENERATION_STATUS_LABEL: Readonly<Record<CampaignGenerationJob["status"], string>> = {
  "needs-approval": "Waiting For Approval",
  queued: "Queued",
  running: "Making It",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Names the screen maps to icons, so state is never colour alone. */
export type GenerationStatusIcon =
  | "waiting"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

const GENERATION_STATUS_ICON: Readonly<
  Record<CampaignGenerationJob["status"], GenerationStatusIcon>
> = {
  "needs-approval": "waiting",
  queued: "queued",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export const SETTINGS_PATH_TEXT = "Settings, Connections, Campaign Publishing";

// Jobs

export type GenerationAction = "approve" | "cancel" | "addToPost" | "open" | "makeVideo";

export interface GenerationActionState {
  readonly action: GenerationAction;
  readonly label: string;
  readonly enabled: boolean;
  /** Why a visible button is off. Absent when it is on. */
  readonly reason?: string;
}

export interface GenerationRowState {
  readonly id: string;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly statusIcon: GenerationStatusIcon;
  readonly promptExcerpt: string;
  readonly requester: string;
  readonly costNote: string;
  /** Only for a failed job: why. */
  readonly failure: string | null;
  /** Only for a queued job held back for the card or its night window: why. */
  readonly waitingNote: string | null;
  /** The first file a finished job made, relative to its thread's folder. */
  readonly resultPath: string | null;
  readonly actions: ReadonlyArray<GenerationActionState>;
}

const ADMIN_REASON = "Only an administrator can do this.";
const NO_FRAME_THREAD_REASON =
  "This picture is in the export folder, not in a thread's folder, so a video cannot start from it here.";
const NO_THREAD_REASON =
  "This file is in the export folder, not in a thread's folder, so it cannot be opened here.";

export function promptExcerpt(prompt: string, max = 140): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const requesterLine = (job: Pick<CampaignGenerationJob, "requestedBy">): string =>
  job.requestedBy.kind === "agent" ? "Asked by an agent" : "Asked by a person";

/** The server's cost note, or a plain statement that the cost is not known. Never a guess. */
function costNote(job: Pick<CampaignGenerationJob, "estimatedUsd" | "estimateNote">): string {
  const note = job.estimateNote.trim();
  if (note !== "") return note;
  return job.estimatedUsd === null ? "Cost unknown." : `About $${job.estimatedUsd.toFixed(2)}.`;
}

/**
 * One job as a row. Approving and cancelling spend or stop the owner's money, so both need the
 * administrator scope; a person without it still sees them, switched off with the reason. Adding to
 * a post only writes a draft, so anyone who can write posts may.
 */
export function generationRow(
  job: CampaignGenerationJob,
  input: {
    readonly isAdministrator: boolean;
    /** False where there is no campaign to start a post in (Settings); the button is left out. */
    readonly canAddToPost?: boolean;
    /** True where a Generate form can be opened (the campaign board); off in Settings. */
    readonly canMakeVideo?: boolean;
  },
): GenerationRowState {
  const actions: GenerationActionState[] = [];
  const adminOnly = (action: GenerationAction, label: string) =>
    actions.push({
      action,
      label,
      enabled: input.isAdministrator,
      ...(input.isAdministrator ? {} : { reason: ADMIN_REASON }),
    });
  if (job.status === "needs-approval") adminOnly("approve", "Approve");
  if (job.status === "needs-approval" || job.status === "queued" || job.status === "running") {
    adminOnly("cancel", "Cancel");
  }
  const resultPath = job.status === "done" ? (job.resultPaths[0] ?? null) : null;
  if (resultPath !== null) {
    if (input.canAddToPost !== false) {
      actions.push({ action: "addToPost", label: "Add To A New Post", enabled: true });
    }
    const hasThread = job.sourceThreadId !== undefined;
    actions.push({
      action: "open",
      label: "Open",
      enabled: hasThread,
      ...(hasThread ? {} : { reason: NO_THREAD_REASON }),
    });
    // A finished picture can become the first frame of a video. That uses the owner's card, so
    // administrators only; it also needs the thread's folder, where the picture was saved.
    if (job.kind === "image" && input.canMakeVideo === true) {
      actions.push({
        action: "makeVideo",
        label: "Make A Video From This",
        enabled: input.isAdministrator && hasThread,
        ...(!input.isAdministrator
          ? { reason: ADMIN_REASON }
          : hasThread
            ? {}
            : { reason: NO_FRAME_THREAD_REASON }),
      });
    }
  }
  return {
    id: job.id,
    kindLabel: KIND_LABEL[job.kind],
    statusLabel: GENERATION_STATUS_LABEL[job.status],
    statusIcon: GENERATION_STATUS_ICON[job.status],
    promptExcerpt: promptExcerpt(job.prompt),
    requester: requesterLine(job),
    costNote: costNote(job),
    failure:
      job.status === "failed"
        ? job.error?.trim() || "It failed, and no reason was recorded."
        : null,
    waitingNote:
      job.status === "queued" && job.waitingNote !== undefined && job.waitingNote.trim() !== ""
        ? job.waitingNote.trim()
        : null,
    resultPath,
    actions,
  };
}

/** One client's jobs, newest first. */
export function jobsForClient(
  jobs: ReadonlyArray<CampaignGenerationJob>,
  clientId: string,
): CampaignGenerationJob[] {
  return jobs
    .filter((job) => job.clientId === clientId)
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export const waitingForApprovalCount = (jobs: ReadonlyArray<CampaignGenerationJob>): number =>
  jobs.filter((job) => job.status === "needs-approval").length;

// Spend

const usd = (value: number): string => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

/**
 * This month's estimated spend for one client, in words. The figures are estimates the server
 * keeps, including reservations for unknown-price jobs.
 */
export function spendSummary(
  spend: CampaignGenerationSpend | undefined,
  jobs: ReadonlyArray<CampaignGenerationJob>,
  nowIso: string,
): string {
  if (spend === undefined) return "No spending has been recorded for this client this month.";
  const since = monthStartIso(nowIso);
  const unknown = jobs.some(
    (job) =>
      job.createdAt >= since &&
      (job.status === "queued" || job.status === "running" || job.status === "done") &&
      job.estimatedUsd === null,
  );
  const base =
    spend.capUsd === null
      ? `${usd(spend.usedUsd)} estimated this month. No monthly limit is set.`
      : `${usd(spend.usedUsd)} of a ${usd(spend.capUsd)} monthly limit estimated this month.`;
  return unknown ? `${base} Unknown-price jobs reserve their approved allowances.` : base;
}

// The form

export type GeneratorChoice =
  | {
      readonly kind: "ready";
      readonly generator: Exclude<CampaignGeneratorKind, "none">;
      readonly model: string;
    }
  | { readonly kind: "none" };

/** Which service will make this kind of file, from the settings the board carries. */
export function generatorFor(
  settings: CampaignGenerationSettings,
  kind: CampaignGenerationKind,
): GeneratorChoice {
  const generator = kind === "image" ? settings.imageGenerator : settings.videoGenerator;
  if (generator === "none") return { kind: "none" };
  const model =
    generator === "local"
      ? settings.models.local
      : generator === "local-gpu"
        ? kind === "video"
          ? settings.localGpu.videoModel || LOCAL_GPU_DEFAULT_VIDEO_PRESET
          : settings.localGpu.model || LOCAL_GPU_DEFAULT_PRESET
        : kind === "image"
          ? settings.models.image
          : settings.models.video;
  return { kind: "ready", generator, model };
}

export function generatorLine(choice: GeneratorChoice): string {
  return choice.kind === "none"
    ? "No generator is set for this."
    : `Made by ${GENERATOR_LABEL[choice.generator]}${choice.model.trim() === "" ? "" : ` (${choice.model.trim()})`}.`;
}

export interface GenerationFormValues {
  readonly kind: CampaignGenerationKind;
  readonly prompt: string;
  readonly aspectRatio: NonNullable<CampaignGenerationOptions["aspectRatio"]>;
  /** Typed text, so a half-typed number is not lost. */
  readonly durationSeconds: string;
  readonly resolution: NonNullable<CampaignGenerationOptions["resolution"]>;
  readonly generateAudio: boolean;
  /** Video only: the picture to start from, relative to the chosen thread's folder. Empty is none. */
  readonly firstFrame: string;
  /** Set while the picture is still the one a finished image job made; the server checks it. */
  readonly firstFrameJobId: string;
}

export const emptyGenerationForm: GenerationFormValues = {
  kind: "image",
  prompt: "",
  aspectRatio: "1:1",
  durationSeconds: "6",
  resolution: "720p",
  generateAudio: false,
  firstFrame: "",
  firstFrameJobId: "",
};

/** True when the video will be made on this computer's graphics card, from a still image. */
export const isLocalVideo = (kind: CampaignGenerationKind, choice: GeneratorChoice): boolean =>
  kind === "video" && choice.kind === "ready" && choice.generator === "local-gpu";

/** What this computer's video model makes: whole seconds from `min` to `max`, one quality. */
export function localVideoLimits(model: string): {
  readonly min: number;
  readonly max: number;
  readonly resolutions: ReadonlyArray<"480p">;
} {
  const preset =
    LOCAL_GPU_VIDEO_PRESETS.find((candidate) => candidate.id === model) ??
    LOCAL_GPU_VIDEO_PRESETS[0];
  return { min: preset.minSeconds, max: preset.maxSeconds, resolutions: ["480p"] };
}

/** Resolves the same blank-model defaults as the service, including image-to-video. */
export function generationCapability(
  form: GenerationFormValues,
  choice: GeneratorChoice | undefined,
) {
  if (choice?.kind !== "ready") return undefined;
  const hasFrame = Boolean(form.firstFrame.trim() || form.firstFrameJobId);
  const fallback =
    choice.generator === "fal"
      ? form.kind === "image"
        ? "fal-ai/flux/dev"
        : hasFrame
          ? "fal-ai/veo3.1/image-to-video"
          : "fal-ai/veo3.1"
      : choice.generator === "muapi"
        ? form.kind === "image"
          ? "flux-dev"
          : hasFrame
            ? "veo3.1-image-to-video"
            : "veo3.1-text-to-video"
        : "";
  return getCampaignModelCapability(choice.generator, choice.model.trim() || fallback);
}

/** The form after choosing Image or Video: the shape, length and quality the generator allows. */
export function formForKind(
  form: GenerationFormValues,
  kind: CampaignGenerationKind,
  choice: GeneratorChoice,
): GenerationFormValues {
  if (kind === "image") return { ...form, kind, aspectRatio: "1:1" };
  const capability = generationCapability({ ...form, kind }, choice);
  return {
    ...form,
    kind,
    aspectRatio: capability?.aspectRatios.includes("9:16")
      ? "9:16"
      : (capability?.defaultAspectRatio ?? "9:16"),
    ...(capability
      ? {
          durationSeconds: String(capability.defaultDuration ?? Number(form.durationSeconds)),
          resolution: capability.defaultResolution ?? form.resolution,
          generateAudio: capability.audio === "toggle" ? form.generateAudio : false,
        }
      : {}),
    ...(choice.kind === "ready" && choice.generator === "local-gpu"
      ? {
          durationSeconds: String(localVideoLimits(choice.model).max),
          resolution: "480p" as const,
          generateAudio: false,
        }
      : {}),
  };
}

/** What stops the form from being sent, in words. Empty means it can go. */
export function generationFormProblems(
  form: GenerationFormValues,
  choice?: GeneratorChoice,
): string[] {
  const problems: string[] = [];
  if (form.prompt.trim() === "") problems.push("Write what to make.");
  if (form.prompt.length > CAMPAIGN_GENERATION_PROMPT_MAX) {
    problems.push(`The description is longer than ${CAMPAIGN_GENERATION_PROMPT_MAX} characters.`);
  }
  if (form.kind === "video") {
    const local =
      choice !== undefined && choice.kind === "ready" && isLocalVideo(form.kind, choice);
    const limits =
      local && choice.kind === "ready"
        ? localVideoLimits(choice.model)
        : { min: CAMPAIGN_GENERATION_DURATION_MIN, max: CAMPAIGN_GENERATION_DURATION_MAX };
    const seconds = Number(form.durationSeconds);
    if (
      form.durationSeconds.trim() === "" ||
      !Number.isInteger(seconds) ||
      seconds < limits.min ||
      seconds > limits.max
    ) {
      problems.push(
        `Length must be a whole number of seconds from ${limits.min} to ${limits.max}.`,
      );
    }
    if (local && form.firstFrame.trim() === "") {
      problems.push("This computer makes video from a still image. Choose an image to start from.");
    }
  }
  const capability = generationCapability(form, choice);
  if (capability) {
    const optionError = campaignModelOptionsError(
      capability,
      form.kind,
      formToOptions(form, choice),
    );
    if (optionError) problems.push(optionError);
    if (
      form.prompt.length > capability.maxPromptLength &&
      form.prompt.length <= CAMPAIGN_GENERATION_PROMPT_MAX
    )
      problems.push(
        `This model accepts descriptions up to ${capability.maxPromptLength} characters.`,
      );
  } else if (
    choice?.kind === "ready" &&
    (choice.generator === "fal" || choice.generator === "muapi")
  ) {
    problems.push("Choose a verified model in generation settings.");
  }
  return problems;
}

/** The options for the start call: video-only fields are left off an image. */
export function formToOptions(
  form: GenerationFormValues,
  choice?: GeneratorChoice,
): CampaignGenerationOptions {
  const capability = generationCapability(form, choice);
  const aspect =
    capability && capability.aspectRatios.length === 0 ? {} : { aspectRatio: form.aspectRatio };
  if (form.kind === "image") return aspect;
  const frame = form.firstFrame.trim();
  return {
    ...aspect,
    durationSeconds: Number(form.durationSeconds),
    ...(capability && capability.resolutions.length === 0 ? {} : { resolution: form.resolution }),
    ...(capability
      ? capability.audio === "toggle"
        ? { generateAudio: form.generateAudio }
        : {}
      : choice?.kind === "ready" && choice.generator === "muapi"
        ? {}
        : { generateAudio: form.generateAudio }),
    // The job's own picture is named by its id; a picture chosen by hand is named by its path.
    ...(form.firstFrameJobId !== ""
      ? { firstFrameJobId: form.firstFrameJobId }
      : frame === ""
        ? {}
        : { firstFrame: frame }),
  };
}

/** The form for "Make A Video From This": Video, 9:16, starting from a finished image job. */
export function formFromImageJob(
  job: Pick<CampaignGenerationJob, "id" | "resultPaths">,
  choice: GeneratorChoice,
): GenerationFormValues {
  return {
    ...formForKind(emptyGenerationForm, "video", choice),
    firstFrame: job.resultPaths[0] ?? "",
    firstFrameJobId: job.id,
  };
}

export interface CostPreview {
  /** What the client has used and its limit, in words. */
  readonly spendLine: string;
  /** What this job would cost, or that it is not known. */
  readonly costLine: string;
  /** True when the cost is not known, so the screen can say so plainly. */
  readonly costUnknown: boolean;
  /** Set when the monthly limit would refuse the job. */
  readonly refusal: string | null;
}

/**
 * Before the job is sent: the client's month so far, what this job is expected to cost, and
 * whether the limit would stop it. The estimate and the limit check are the shared rules the
 * server runs, so the screen and the server agree. An unknown cost is said to be unknown.
 */
export function costPreview(input: {
  readonly clientName: string;
  readonly spend: CampaignGenerationSpend | undefined;
  readonly jobs: ReadonlyArray<CampaignGenerationJob>;
  readonly choice: Extract<GeneratorChoice, { kind: "ready" }>;
  readonly form: GenerationFormValues;
  readonly nowIso: string;
  readonly allowanceUsd?: number;
}): CostPreview {
  const seconds = Number(input.form.durationSeconds);
  const estimate = estimateGenerationUsd({
    connector: input.choice.generator,
    kind: input.form.kind,
    model: input.choice.model,
    durationSeconds: input.form.kind === "video" && Number.isFinite(seconds) ? seconds : undefined,
  });
  const decision = checkGenerationSpend({
    clientName: input.clientName,
    capUsd: input.spend?.capUsd ?? null,
    usedUsd: input.spend?.usedUsd ?? 0,
    estimatedUsd: estimate.usd ?? input.allowanceUsd ?? null,
  });
  return {
    spendLine: spendSummary(input.spend, input.jobs, input.nowIso),
    costLine: estimate.usd === null ? `Cost unknown. ${estimate.note}` : estimate.note,
    costUnknown: estimate.usd === null,
    refusal:
      estimate.usd === null &&
      !(
        input.allowanceUsd !== undefined &&
        Number.isFinite(input.allowanceUsd) &&
        input.allowanceUsd > 0
      )
        ? "Enter a positive dollar allowance to approve this unknown-price generation."
        : decision.ok
          ? null
          : decision.message,
  };
}

// Where the files go

export interface FolderThread {
  readonly id: string;
  readonly title: string;
  readonly environmentId: string;
  readonly archivedAt: unknown;
  readonly updatedAt: string;
}

const MAX_FOLDER_CHOICES = 20;

/**
 * The threads a generation may save into, newest first. The server saves into the folder of the
 * thread it is given, or into the export folder from Settings when there is none. `preferredId`
 * (the thread behind the campaign's latest post) is always offered when it exists, and first.
 */
export function folderChoices(
  threads: ReadonlyArray<FolderThread>,
  environmentId: string,
  preferredId: string | undefined,
): FolderThread[] {
  const live = threads
    .filter((thread) => thread.environmentId === environmentId && !thread.archivedAt)
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const preferred = live.find((thread) => thread.id === preferredId);
  const rest = live.filter((thread) => thread !== preferred).slice(0, MAX_FOLDER_CHOICES);
  return preferred === undefined ? rest : [preferred, ...rest];
}

/** The thread behind the campaign's most recently changed post, if any. */
export function latestPostThread(
  posts: ReadonlyArray<{
    readonly sourceThreadId?: string | undefined;
    readonly updatedAt: string;
  }>,
): string | undefined {
  return posts
    .filter((post) => post.sourceThreadId !== undefined)
    .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0]
    ?.sourceThreadId;
}
