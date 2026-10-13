/**
 * What a long wait in a run is, and when a run counts as quiet. Pure helpers shared by the thread's
 * working indicator, the sidebar and the Agents Team Board so all three say the same thing.
 */

const QUIET_RUN_THRESHOLD_MS = 10 * 60_000;

/** What Nudge sends into a quiet run. */
export const RUN_NUDGE_TEXT = "Status check: say what you are waiting on, or continue.";

export type RunWait =
  | {
      readonly kind: "sleep";
      readonly totalMs: number;
      /** Null when the start time is unknown. Zero once the sleep should have finished. */
      readonly remainingMs: number | null;
      /** Epoch ms the sleep ends, null when the start time is unknown. */
      readonly endsAtMs: number | null;
      readonly label: string;
    }
  | {
      readonly kind: "page";
      readonly totalMs: null;
      readonly remainingMs: null;
      readonly endsAtMs: null;
      readonly label: string;
    };

export interface RunWaitInput {
  /** Raw shell command of the latest in-progress work item, if it is a command. */
  readonly command?: string | null | undefined;
  /** Tool name of the latest in-progress work item, if it is a tool call. */
  readonly toolName?: string | null | undefined;
  /** When that work item started. */
  readonly startedAt?: string | null | undefined;
}

const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:bash|sh|zsh|dash)\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1$/u;
// Only plain `sleep <number>[smhd]` and the Windows-style `timeout [/t] <seconds>`.
const SLEEP_SEGMENT = /^sleep\s+(\d+(?:\.\d+)?)([smhd]?)$/u;
const TIMEOUT_SEGMENT = /^timeout\s+(?:\/t\s+)?(\d+)$/iu;
const PAGE_WAIT_TOOL = /(?:^|__|\.|:)preview_wait_for$/u;
const MAX_SLEEP_MS = 7 * 24 * 3_600_000;

const UNIT_MS = { "": 1_000, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function sleepDurationMs(command: string): number | null {
  const wrapped = SHELL_WRAPPER.exec(command.trim());
  const body = (wrapped?.[2] ?? command).trim();
  // The wait is only what the command is blocked on, so it must be the last command in the chain.
  const last = body.split(/&&|;/u).at(-1)?.trim();
  if (!last) return null;
  const sleep = SLEEP_SEGMENT.exec(last);
  const timeout = sleep ? null : TIMEOUT_SEGMENT.exec(last);
  const amount = Number(sleep?.[1] ?? timeout?.[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (sleep?.[2] ?? "") as keyof typeof UNIT_MS;
  const ms = Math.round(amount * UNIT_MS[unit]);
  return ms > 0 && ms <= MAX_SLEEP_MS ? ms : null;
}

function formatSpan(ms: number): string {
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Remaining time in whole minutes, rounded up: the label refreshes on the minute clock, so a
 * seconds countdown would only ever be stale.
 */
function formatRemaining(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h left` : `${hours} h ${minutes % 60} min left`;
}

/** Describes a wait from the latest in-progress work item, or null when it is not a known wait. */
export function describeRunWait(input: RunWaitInput, nowMs: number): RunWait | null {
  if (input.toolName && PAGE_WAIT_TOOL.test(input.toolName.trim())) {
    return {
      kind: "page",
      totalMs: null,
      remainingMs: null,
      endsAtMs: null,
      label: "Waiting on a page",
    };
  }
  if (!input.command) return null;
  const totalMs = sleepDurationMs(input.command);
  if (totalMs === null) return null;
  const startedMs = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const remainingMs = Number.isFinite(startedMs) ? Math.max(0, startedMs + totalMs - nowMs) : null;
  const base = `Sleeping ${formatSpan(totalMs)}`;
  return {
    kind: "sleep",
    totalMs,
    remainingMs,
    endsAtMs: Number.isFinite(startedMs) ? startedMs + totalMs : null,
    label:
      remainingMs !== null && remainingMs > 0 ? `${base} (${formatRemaining(remainingMs)})` : base,
  };
}

function validMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whole minutes a run has produced nothing, once past the threshold; null otherwise. The clock
 * starts at the later of the run start and the last output. A sleep that has not yet elapsed is
 * the agent doing what it said, so it is never quiet; after it elapses the clock starts at its end.
 */
export function resolveQuietMinutes(input: {
  readonly runStartedAt: string | null | undefined;
  readonly lastActivityAt: string | null | undefined;
  readonly nowMs: number;
  readonly wait?: RunWait | null | undefined;
  readonly thresholdMs?: number;
}): number | null {
  const startedMs = validMs(input.runStartedAt);
  const lastMs = validMs(input.lastActivityAt);
  let sinceMs = Math.max(startedMs ?? Number.NEGATIVE_INFINITY, lastMs ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(sinceMs)) return null;
  const wait = input.wait;
  if (wait?.kind === "sleep" && wait.remainingMs !== null && wait.endsAtMs !== null) {
    if (wait.remainingMs > 0) return null;
    sinceMs = Math.max(sinceMs, wait.endsAtMs);
  }
  const quietMs = input.nowMs - sinceMs;
  return quietMs >= (input.thresholdMs ?? QUIET_RUN_THRESHOLD_MS)
    ? Math.floor(quietMs / 60_000)
    : null;
}

export function formatQuietLabel(quietMinutes: number): string {
  return quietMinutes >= 60
    ? `Quiet for ${Math.floor(quietMinutes / 60)}h ${quietMinutes % 60}m`
    : `Quiet for ${quietMinutes}m`;
}
