/** Past this much recording the live preview stops: re-reading a long recording every few seconds costs more than it helps. */
export const PREVIEW_MAX_RECORDING_MS = 60_000;
const PREVIEW_MIN_INTERVAL_MS = 1000;
/** A pass may take about two thirds of the time between preview starts. */
const PREVIEW_COST_FACTOR = 1.5;
// Chunks arrive on a one-second timer, so a chunk can land a few milliseconds early.
const TIMER_JITTER_MS = 100;

export type PreviewDecision = "start" | "wait" | "paused";

/**
 * Whether to start a live preview pass now. Each pass re-transcribes the whole recording, so the
 * gap between starts grows with how long the previous pass took (never under a second), only one
 * pass runs at a time, and previews end for good once the recording passes a minute.
 */
export function decidePreview(input: {
  readonly recordedMs: number;
  /** Time since the last pass started, or null before the first. */
  readonly sinceLastStartMs: number | null;
  /** How long the last pass took, or null before one has finished. */
  readonly lastPassMs: number | null;
  readonly inFlight: boolean;
  readonly chunkCount: number;
}): PreviewDecision {
  if (input.recordedMs > PREVIEW_MAX_RECORDING_MS) return "paused";
  // The first chunk holds only the container header, so there is nothing to hear yet.
  if (input.inFlight || input.chunkCount < 2) return "wait";
  if (input.sinceLastStartMs === null) return "start";
  const interval = Math.max(PREVIEW_MIN_INTERVAL_MS, PREVIEW_COST_FACTOR * (input.lastPassMs ?? 0));
  return input.sinceLastStartMs >= interval - TIMER_JITTER_MS ? "start" : "wait";
}
