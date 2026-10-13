/**
 * Plain-language notification text for a thread: a short status label and a
 * one-line excerpt of what the agent actually said. Phone push, the web toast,
 * the OS notification and the bell menu all read from here so they agree.
 */

export type ThreadNotificationKind =
  | "completed"
  | "failed"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "limited";

export interface ThreadNotificationInput {
  readonly kind: ThreadNotificationKind;
  /** Markdown of the agent's latest reply, when the caller has it. */
  readonly assistantText?: string | null | undefined;
  readonly errorText?: string | null | undefined;
  /** ISO time the usage limit lifts, for `limited`. */
  readonly usageLimitResetAt?: string | null | undefined;
}

export interface ThreadNotificationText {
  readonly label: string;
  readonly excerpt: string;
  /** True when `excerpt` is a stock phrase because there was no real text to show. */
  readonly isFallback: boolean;
}

export interface ThreadNotificationFormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
  /** The current time, so a reset later today can drop the weekday. */
  readonly nowMs?: number;
}

const NOTIFICATION_EXCERPT_MAX_LENGTH = 140;

const LABELS: Record<ThreadNotificationKind, string> = {
  completed: "Finished",
  failed: "Failed",
  waiting_for_input: "Needs your answer",
  waiting_for_approval: "Needs approval",
  limited: "Usage limit reached",
};

const FALLBACK_EXCERPTS: Record<Exclude<ThreadNotificationKind, "limited">, string> = {
  completed: "Reply ready",
  failed: "The run stopped with an error.",
  waiting_for_input: "The agent is waiting for your answer.",
  waiting_for_approval: "The agent is waiting for your approval.",
};

const TERMINAL_PUNCTUATION = /[.!?:;]$/;

/** Reduce markdown to the readable prose a person would skim, on one line. */
function markdownToPlainLine(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      // A closing fence is bare and at least as long as the opener; anything else is code.
      if (/^(`{3,}|~{3,})$/.test(line) && line[0] === fence[0] && line.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (line === "" || /^([-*_]\s*){3,}$/.test(line)) continue;
    if (line.startsWith("|") || /^:?-{2,}:?(\s*\|\s*:?-{2,}:?)+$/.test(line)) continue;
    const block = /^(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/.exec(line);
    const text = block === null ? line : line.slice(block[0].length);
    const cleaned = stripInlineMarkdown(text);
    if (cleaned === "") continue;
    // Headings and list items are fragments; end them so they read as sentences.
    lines.push(block !== null && !TERMINAL_PUNCTUATION.test(cleaned) ? `${cleaned}.` : cleaned);
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

function stripInlineMarkdown(text: string): string {
  return (
    text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/\*([^*\s][^*]*)\*/g, "$1")
      // Underscores only emphasise at word edges; snake_case stays intact.
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1")
      .trim()
  );
}

function truncateAtWord(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const room = text.slice(0, maxLength - 1);
  const lastSpace = room.lastIndexOf(" ");
  const cut = lastSpace >= maxLength * 0.4 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s,;:\-–—]+$/, "")}…`;
}

/**
 * One clean line from markdown: the first sentence or two that fit in
 * `maxLength`, cut on a word boundary with an ellipsis when longer.
 */
export function notificationExcerpt(
  markdown: string | null | undefined,
  maxLength: number = NOTIFICATION_EXCERPT_MAX_LENGTH,
): string {
  if (!markdown) return "";
  const plain = markdownToPlainLine(markdown);
  if (plain === "") return "";
  const sentences = plain.match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? [plain];
  let excerpt = "";
  for (const sentence of sentences.slice(0, 2)) {
    const next = excerpt === "" ? sentence.trim() : `${excerpt} ${sentence.trim()}`;
    if (next.length > maxLength) break;
    excerpt = next;
  }
  return excerpt === "" ? truncateAtWord(plain, maxLength) : excerpt;
}

function formatUsageLimitReset(
  resetAt: string,
  options: ThreadNotificationFormatOptions,
): string | null {
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return null;
  const nowMs = options.nowMs;
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const day = new Intl.DateTimeFormat(options.locale, { ...zone, dateStyle: "short" });
  const time = new Intl.DateTimeFormat(options.locale, {
    ...zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(resetMs);
  // Without a clock the weekday is always shown, which is never wrong.
  if (
    nowMs !== undefined &&
    resetMs - nowMs < 20 * 60 * 60 * 1_000 &&
    day.format(resetMs) === day.format(nowMs)
  ) {
    return `Resets at ${time}`;
  }
  const weekday = new Intl.DateTimeFormat(options.locale, { ...zone, weekday: "short" });
  return `Resets ${weekday.format(resetMs)} at ${time}`;
}

/** The label and one-line excerpt a notification should show for a thread. */
export function threadNotificationText(
  input: ThreadNotificationInput,
  options: ThreadNotificationFormatOptions = {},
): ThreadNotificationText {
  const label = LABELS[input.kind];
  if (input.kind === "limited") {
    const reset =
      input.usageLimitResetAt == null
        ? null
        : formatUsageLimitReset(input.usageLimitResetAt, options);
    return { label, excerpt: reset ?? "Try again later.", isFallback: reset === null };
  }
  const source = input.kind === "failed" ? input.errorText : input.assistantText;
  const excerpt = notificationExcerpt(source);
  return excerpt === ""
    ? { label, excerpt: FALLBACK_EXCERPTS[input.kind], isFallback: true }
    : { label, excerpt, isFallback: false };
}

/** The agent's words from a shell's latest visible message, if it is the assistant's. */
export function assistantTextFromLatestMessage(
  message: { readonly role: string; readonly text: string } | null | undefined,
): string | null {
  return message?.role === "assistant" ? message.text : null;
}

/** Project names that only repeat the thread title, or are blank, add nothing. */
export function meaningfulProjectTitle(
  projectTitle: string | null | undefined,
  threadTitle: string,
): string | null {
  const project = projectTitle?.trim() ?? "";
  if (project === "" || project.toLowerCase() === threadTitle.trim().toLowerCase()) return null;
  return project;
}

/** "<label>" or "<label> · <project>", with no empty segments. */
export function notificationSubtitle(
  label: string,
  projectTitle: string | null | undefined,
  threadTitle: string,
): string {
  const project = meaningfulProjectTitle(projectTitle, threadTitle);
  const trimmedLabel = label.trim();
  return project === null ? trimmedLabel : `${trimmedLabel} · ${project}`;
}
