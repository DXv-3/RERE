import {
  CAMPAIGN_PLATFORM_LABELS,
  ThreadId,
  type CampaignApprovalMode,
  type CampaignClient,
  type CampaignPlatform,
  type CampaignPost,
  type CampaignPostApproval,
  type CampaignPostStatus,
  type CampaignPostUpsertInput,
  type CampaignSummary,
} from "@t3tools/contracts";
import {
  approvedByLabel,
  captionFor,
  effectiveMode,
  statusAfterEdit,
  validateCampaignPost,
} from "@t3tools/shared/campaignRules";

/**
 * What the campaigns screens decide, with no React and no I/O: which column a post sits in, which
 * buttons it gets, how its time and summary read, and how a failure is worded. The rules about who
 * may move a post live in `@t3tools/shared/campaignRules`; these helpers only ask them.
 */

const BOARD_COLUMNS = [
  "draft",
  "needs-approval",
  "approved",
  "scheduled",
  "posted",
  "failed",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const POST_STATUS_LABEL: Readonly<Record<CampaignPostStatus, string>> = {
  draft: "Draft",
  "needs-approval": "Needs Approval",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  posted: "Posted",
  failed: "Failed",
  rejected: "Rejected",
};

export const MODE_OPTIONS: ReadonlyArray<{
  readonly mode: CampaignApprovalMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "ask-first",
    label: "Ask Me First",
    description: "Every post waits here until an administrator approves it.",
  },
  {
    mode: "report-when-done",
    label: "Report When Done",
    description: "Posts go out on schedule and the agent tells you what it posted.",
  },
  {
    mode: "auto-publish",
    label: "Auto Publish",
    description: "Posts go out on schedule with no report beyond the log.",
  },
];

export const modeLabel = (mode: CampaignApprovalMode): string =>
  MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? mode;

export const modeDescription = (mode: CampaignApprovalMode): string =>
  MODE_OPTIONS.find((option) => option.mode === mode)?.description ?? "";

/** Where a mode applies: a whole client, or one campaign that overrides its client. */
export type ModeScope = { readonly kind: "client" | "campaign"; readonly name: string };

/**
 * The confirmation for moving a client or campaign to a mode that lets posts go out without a
 * person approving each one. Ask Me First needs none: it only makes things stricter.
 */
export function modeChangeConfirmation(
  mode: CampaignApprovalMode,
  scope: ModeScope,
): { readonly title: string; readonly body: string; readonly confirmLabel: string } | null {
  if (mode === "ask-first") return null;
  const where = scope.kind === "client" ? `all of ${scope.name}'s campaigns` : `${scope.name}`;
  const report =
    mode === "report-when-done"
      ? "The agent will tell you what it posted afterwards."
      : "You will not be told beyond the publish log.";
  return {
    title: `Switch To ${modeLabel(mode)}?`,
    body: `From now on, posts an agent finishes for ${where} are approved by this setting and go out at their scheduled time, or right away when they have no time. Nobody will be asked first. ${report} Only an administrator can change this back.`,
    confirmLabel: `Switch To ${modeLabel(mode)}`,
  };
}

/** Which mode is in force for a campaign and whether it comes from the campaign itself. */
export function modeInForce(
  client: Pick<CampaignClient, "approvalMode"> | undefined,
  campaign: Pick<CampaignSummary, "approvalMode">,
): { readonly mode: CampaignApprovalMode; readonly overridden: boolean } {
  const mode = effectiveMode(client ?? { approvalMode: "ask-first" }, campaign);
  return { mode, overridden: campaign.approvalMode !== undefined };
}

// Columns

const timeValue = (iso: string | undefined): number | null => {
  if (iso === undefined) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

/** Soonest first, posts without a time last, then the newest edit. */
const bySchedule = (a: CampaignPost, b: CampaignPost): number => {
  const left = timeValue(a.scheduledAt);
  const right = timeValue(b.scheduledAt);
  if (left !== null && right !== null && left !== right) return left - right;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return byNewest(a, b);
};

const byNewest = (a: CampaignPost, b: CampaignPost): number =>
  (timeValue(b.updatedAt) ?? 0) - (timeValue(a.updatedAt) ?? 0);

export interface BoardGroups {
  readonly columns: ReadonlyArray<{
    readonly status: BoardColumn;
    readonly label: string;
    readonly posts: ReadonlyArray<CampaignPost>;
  }>;
  readonly rejected: ReadonlyArray<CampaignPost>;
}

/**
 * Posts into the board's columns. A post being sent right now sits with Scheduled, since it is
 * about to be Posted or Failed. Rejected posts are kept apart for the collapsed group.
 */
export function groupPostsByColumn(posts: ReadonlyArray<CampaignPost>): BoardGroups {
  const columnOf = (status: CampaignPostStatus): BoardColumn | null =>
    status === "rejected" ? null : status === "publishing" ? "scheduled" : status;
  const buckets = new Map<BoardColumn, CampaignPost[]>(BOARD_COLUMNS.map((c) => [c, []]));
  const rejected: CampaignPost[] = [];
  for (const post of posts) {
    const column = columnOf(post.status);
    if (column === null) rejected.push(post);
    else buckets.get(column)?.push(post);
  }
  return {
    columns: BOARD_COLUMNS.map((status) => {
      const list = buckets.get(status) ?? [];
      const ordered =
        status === "approved" || status === "scheduled"
          ? list.toSorted(bySchedule)
          : list.toSorted(byNewest);
      return { status, label: POST_STATUS_LABEL[status], posts: ordered };
    }),
    rejected: rejected.toSorted(byNewest),
  };
}

// Time

const dayNumber = (date: Date, timeZone: string | undefined): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
};

/**
 * A time in plain words: "Tomorrow 9:00 AM", "Friday 2:30 PM" within the next week, otherwise
 * the date. `timeZone` and `locale` are for tests; the screens use the person's own.
 */
export function formatPostTime(
  iso: string | undefined,
  now: Date,
  options: { readonly timeZone?: string; readonly locale?: string } = {},
): string | null {
  if (iso === undefined) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const { timeZone, locale } = options;
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  const diff = dayNumber(at, timeZone) - dayNumber(now, timeZone);
  if (diff === 0) return `Today ${clock}`;
  if (diff === 1) return `Tomorrow ${clock}`;
  if (diff === -1) return `Yesterday ${clock}`;
  if (diff > 1 && diff < 7) {
    return `${new Intl.DateTimeFormat(locale, { timeZone, weekday: "long" }).format(at)} ${clock}`;
  }
  const sameYear =
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at) ===
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
  return `${date}, ${clock}`;
}

/** An ISO time as the value a `datetime-local` input wants, in the person's own zone. */
export function isoToLocalInput(iso: string | undefined): string {
  if (iso === undefined) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The reverse: a `datetime-local` value as an ISO time, or null when it is empty or not a time. */
export function localInputToIso(value: string): string | null {
  if (value.trim() === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

// Cards

const PLATFORM_SHORT_LABEL: Readonly<Record<CampaignPlatform, string>> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  gbp: "Google",
  pinterest: "Pinterest",
};

const CAPTION_EXCERPT_MAX = 120;

/** The caption people read on a card: the default, else the first platform's own, trimmed. */
export function captionExcerpt(post: Pick<CampaignPost, "captions" | "platforms">): string {
  const first = post.platforms[0];
  const source =
    post.captions.default.trim() !== ""
      ? post.captions.default
      : first !== undefined
        ? captionFor(post, first)
        : "";
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > CAPTION_EXCERPT_MAX ? `${flat.slice(0, CAPTION_EXCERPT_MAX - 1)}…` : flat;
}

/** Who approved a post, in words. Null when nobody has. */
export function approvalLine(approval: CampaignPostApproval): string | null {
  const who = approvedByLabel(approval);
  if (who === "none") return null;
  if (who === "person") return "Approved by a person";
  const mode = approval !== null && approval.by === "mode" ? approval.mode : null;
  return mode === null ? null : `Approved by the ${modeLabel(mode)} setting`;
}

export const creatorLine = (post: Pick<CampaignPost, "createdBy">): string =>
  post.createdBy.kind === "agent" ? "Drafted by an agent" : "Written by a person";

export interface CardSummary {
  readonly caption: string;
  readonly platforms: ReadonlyArray<string>;
  readonly mediaCount: number;
  readonly time: string | null;
  readonly creator: string;
  /** Only for posts that were approved at some point and are still on their way or done. */
  readonly approval: string | null;
}

const SHOWS_APPROVAL: ReadonlySet<CampaignPostStatus> = new Set([
  "approved",
  "scheduled",
  "publishing",
  "posted",
]);

export function cardSummary(post: CampaignPost, now: Date): CardSummary {
  return {
    caption: captionExcerpt(post),
    platforms: post.platforms.map((platform) => PLATFORM_SHORT_LABEL[platform]),
    mediaCount: post.mediaPaths.length + post.mediaUrls.length,
    time: formatPostTime(post.scheduledAt, now),
    creator: creatorLine(post),
    approval: SHOWS_APPROVAL.has(post.status) ? approvalLine(post.approval) : null,
  };
}

/** The one line under a card's caption, e.g. "Instagram, Facebook · 2 files · Tomorrow 9:00 AM". */
export function cardSummaryLine(summary: CardSummary): string {
  const parts = [
    summary.platforms.length > 0 ? summary.platforms.join(", ") : "No platform yet",
    summary.mediaCount === 0
      ? null
      : `${summary.mediaCount} ${summary.mediaCount === 1 ? "file" : "files"}`,
    summary.time,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

export const needsApprovalCount = (campaign: Pick<CampaignSummary, "postCounts">): number =>
  campaign.postCounts["needs-approval"] ?? 0;

// Actions

export type PostAction =
  | "submit"
  | "approve"
  | "requestChanges"
  | "reject"
  | "publishNow"
  | "retry"
  | "delete";

export interface PostActionState {
  readonly action: PostAction;
  readonly label: string;
  readonly enabled: boolean;
  /** Why it is off, when it is. */
  readonly reason?: string;
  /** Asks first, because it cannot be undone or sends something out. */
  readonly confirm: boolean;
  readonly destructive: boolean;
}

const ADMIN_ONLY = "Only an administrator can do this.";

const ACTION_LABEL: Readonly<Record<PostAction, string>> = {
  submit: "Submit For Approval",
  approve: "Approve",
  requestChanges: "Request Changes",
  reject: "Reject",
  publishNow: "Publish Now",
  retry: "Retry",
  delete: "Delete",
};

/** Which actions each status offers, in the order they are shown. */
const ACTIONS_BY_STATUS: Readonly<Record<CampaignPostStatus, ReadonlyArray<PostAction>>> = {
  draft: ["submit", "approve", "delete"],
  "needs-approval": ["approve", "requestChanges", "reject", "publishNow", "delete"],
  approved: ["publishNow", "requestChanges", "reject", "delete"],
  scheduled: ["publishNow", "requestChanges", "reject", "delete"],
  publishing: [],
  posted: ["delete"],
  failed: ["retry", "requestChanges", "reject", "delete"],
  rejected: ["delete"],
};

/**
 * The buttons a post gets. Everything except Submit needs an administrator, and the list is cut to
 * what the server will accept for the status, so a button never leads to a refusal that the rules
 * could have told the person about first. A person's Submit under a mode that publishes on its own
 * would approve the post, so it is left to administrators there.
 */
export function availablePostActions(
  post: Pick<CampaignPost, "status">,
  context: {
    readonly isAdministrator: boolean;
    readonly mode: CampaignApprovalMode;
    /** Problems found by `validateCampaignPost`; they block approving and publishing. */
    readonly problems?: ReadonlyArray<string>;
  },
): PostActionState[] {
  const problems = context.problems ?? [];
  return ACTIONS_BY_STATUS[post.status].map((action) => {
    let reason: string | undefined;
    if (action === "submit") {
      if (context.mode !== "ask-first" && !context.isAdministrator) {
        reason = "This campaign publishes on its own, so only an administrator can submit.";
      } else if (problems.length > 0) reason = "Fix the problems listed first.";
    } else if (!context.isAdministrator) {
      reason = ADMIN_ONLY;
    } else if ((action === "approve" || action === "publishNow") && problems.length > 0) {
      reason = "Fix the problems listed first.";
    }
    return {
      action,
      label: ACTION_LABEL[action],
      enabled: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      confirm: action === "publishNow" || action === "reject" || action === "delete",
      destructive: action === "reject" || action === "delete",
    };
  });
}

/** Whether the content fields can be edited. An edit returns the post to Draft. */
export const canEditPost = (status: CampaignPostStatus): boolean =>
  (status === "draft" || status === "needs-approval") && statusAfterEdit(status, "person") !== null;

/** The sentence a confirmation shows for an action that asks first. */
export function confirmationText(
  action: PostAction,
  mode: CampaignApprovalMode,
  connector: "export" | "marketing-engine",
): { readonly title: string; readonly body: string; readonly confirmLabel: string } | null {
  switch (action) {
    case "publishNow":
      return {
        title: "Publish This Post Now?",
        body:
          connector === "export"
            ? "The post is approved and saved as a folder you can post by hand."
            : `The post is approved and sent to every platform it lists as soon as publishing allows. This cannot be undone. The campaign is on ${modeLabel(mode)}.`,
        confirmLabel: "Publish Now",
      };
    case "reject":
      return {
        title: "Reject This Post?",
        body: "It moves to Rejected and will not go out. You can open it later and edit it to start again.",
        confirmLabel: "Reject",
      };
    case "delete":
      return {
        title: "Delete This Post?",
        body: "The post, its captions and its publish log are removed. This cannot be undone.",
        confirmLabel: "Delete",
      };
    default:
      return null;
  }
}

// Problems

export function postProblems(
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
  client: Pick<CampaignClient, "doNotSay"> | undefined,
): string[] {
  return validateCampaignPost(post, { doNotSay: client?.doNotSay ?? [] }).map(capitalise);
}

/** The rules name platforms in lower case ("instagram needs..."); say them the way people do. */
function capitalise(problem: string): string {
  let text = problem;
  for (const [id, label] of Object.entries(CAMPAIGN_PLATFORM_LABELS)) {
    text = text.replace(new RegExp(`\\b${id}\\b`, "g"), label);
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Failures

const AUTHORIZATION_MESSAGE =
  "Only an administrator can do this. Sign in as an administrator, or ask the person who runs this CodeWrench.";
const FALLBACK_MESSAGE = "Could not reach campaigns. Check your connection and try again.";

/**
 * A failure from `campaigns.mutate` or `campaigns.subscribe` in words for the person. The server
 * already writes its refusals for people, so those are shown as sent; anything else gets a
 * general sentence rather than a technical one.
 */
export function campaignFailureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return FALLBACK_MESSAGE;
  const { _tag, reason, message } = error as {
    _tag?: unknown;
    reason?: unknown;
    message?: unknown;
  };
  const text = typeof message === "string" ? message.trim() : "";
  if (_tag === "EnvironmentAuthorizationError") return AUTHORIZATION_MESSAGE;
  if (_tag === "CampaignError") {
    switch (reason) {
      case "not_found":
        return text || "That no longer exists. It may have been deleted on another device.";
      case "invalid":
      case "not_allowed":
      case "conflict":
        return text || "The server did not accept that. Check it and try again.";
      case "storage":
        return "The server could not save this. Try again.";
      case "unavailable":
        return text || "Publishing is not available right now. Try again later.";
      default:
        return FALLBACK_MESSAGE;
    }
  }
  if (_tag === "EnvironmentRpcUnavailableError") {
    return "This environment is not connected right now. Reconnect and try again.";
  }
  return FALLBACK_MESSAGE;
}

// Forms

/** One phrase per line, blanks dropped, repeats (ignoring case) dropped. */
export function parseDoNotSay(text: string): string[] {
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const phrase = line.trim();
    const key = phrase.toLowerCase();
    if (phrase === "" || seen.has(key)) continue;
    seen.add(key);
    phrases.push(phrase);
  }
  return phrases;
}

export const formatDoNotSay = (phrases: ReadonlyArray<string>): string => phrases.join("\n");

/** A monthly spend cap typed in dollars. Empty means no cap. */
export function parseSpendCap(
  text: string,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false } {
  const trimmed = text.trim().replace(/^\$/, "");
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? { ok: true, value } : { ok: false };
}

export type MediaEntry =
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "url"; readonly value: string }
  | { readonly kind: "invalid"; readonly message: string };

/** A media entry typed or pasted: an https link, or a path inside the thread's folder. */
export function parseMediaEntry(text: string): MediaEntry {
  const value = text.trim();
  if (value === "") return { kind: "invalid", message: "Type a file path or paste a link." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return { kind: "url", value };
    } catch {
      // Falls through to the message below.
    }
    return { kind: "invalid", message: "Links must start with https://." };
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).includes("..")
  ) {
    return {
      kind: "invalid",
      message: "Use a path inside the project folder, like campaigns/launch/reel.mp4.",
    };
  }
  return { kind: "path", value };
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;
const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|mkv|avi)(\?.*)?$/i;

export const isImageName = (name: string): boolean => IMAGE_EXTENSION.test(name);
export const isVideoName = (name: string): boolean => VIDEO_EXTENSION.test(name);

export interface PostForm {
  readonly platforms: ReadonlyArray<CampaignPlatform>;
  readonly defaultCaption: string;
  readonly platformCaptions: Readonly<Record<string, string>>;
  readonly scheduledAt: string;
  readonly title: string;
  readonly destinationUrl: string;
  readonly mediaPaths: ReadonlyArray<string>;
  readonly mediaUrls: ReadonlyArray<string>;
}

export const postToForm = (post: CampaignPost): PostForm => ({
  platforms: post.platforms,
  defaultCaption: post.captions.default,
  platformCaptions: post.captions.byPlatform,
  scheduledAt: isoToLocalInput(post.scheduledAt),
  title: post.title ?? "",
  destinationUrl: post.destinationUrl ?? "",
  mediaPaths: post.mediaPaths,
  mediaUrls: post.mediaUrls,
});

export const emptyPostForm: PostForm = {
  platforms: [],
  defaultCaption: "",
  platformCaptions: {},
  scheduledAt: "",
  title: "",
  destinationUrl: "",
  mediaPaths: [],
  mediaUrls: [],
};

/** A form read as the post it would make, for the same checks the server runs. */
export function formToPostContent(
  form: PostForm,
): Pick<
  CampaignPost,
  "platforms" | "captions" | "mediaPaths" | "mediaUrls" | "title" | "destinationUrl" | "scheduledAt"
> {
  const byPlatform = Object.fromEntries(
    Object.entries(form.platformCaptions).filter(
      ([platform, caption]) =>
        form.platforms.includes(platform as CampaignPlatform) && caption.trim() !== "",
    ),
  );
  const scheduledAt = localInputToIso(form.scheduledAt);
  return {
    platforms: form.platforms,
    captions: { default: form.defaultCaption, byPlatform },
    mediaPaths: form.mediaPaths,
    mediaUrls: form.mediaUrls,
    ...(form.title.trim() === "" ? {} : { title: form.title.trim() }),
    ...(form.destinationUrl.trim() === "" ? {} : { destinationUrl: form.destinationUrl.trim() }),
    // A time that is typed but not a time is kept so the rules can say so.
    ...(scheduledAt !== null
      ? { scheduledAt }
      : form.scheduledAt.trim() === ""
        ? {}
        : { scheduledAt: "invalid" }),
  };
}

/** The save call for a form: the same fields every time, with empty ones sent as "clear". */
export function formToSaveInput(
  form: PostForm,
  target: {
    readonly campaignId: string;
    readonly postId?: string;
    /** Only for a new post: the thread whose folder holds its files. */
    readonly sourceThreadId?: string;
  },
): CampaignPostUpsertInput {
  const content = formToPostContent(form);
  return {
    ...(target.postId === undefined ? {} : { id: target.postId }),
    campaignId: target.campaignId,
    platforms: content.platforms,
    captions: content.captions,
    mediaPaths: content.mediaPaths,
    mediaUrls: content.mediaUrls,
    title: content.title ?? null,
    destinationUrl: content.destinationUrl ?? null,
    scheduledAt: localInputToIso(form.scheduledAt),
    ...(target.sourceThreadId === undefined
      ? {}
      : { sourceThreadId: ThreadId.make(target.sourceThreadId) }),
  };
}

/** Whether the form differs from the saved post, so Save is only offered for a real change. */
export function formIsChanged(form: PostForm, post: CampaignPost): boolean {
  const saved = formToPostContent(postToForm(post));
  const current = formToPostContent(form);
  return JSON.stringify(saved) !== JSON.stringify(current);
}

/** What to ask an agent when a campaign has no posts. Copied, not sent. */
export function draftRequestText(clientName: string, campaignName: string): string {
  return `Please draft three posts for the "${campaignName}" campaign for ${clientName}. Use your campaign tools to save each one as a draft with captions, platforms and a proposed time, then submit them for approval.`;
}
