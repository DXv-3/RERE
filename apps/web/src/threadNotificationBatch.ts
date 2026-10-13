/**
 * Groups threads that finish close together into one "N threads finished"
 * notification, so a burst of completions is a single interruption.
 */
export const COMPLETION_BATCH_WINDOW_MS = 20_000;
const MAX_LISTED_TITLES = 3;

export interface CompletionBatch {
  count: number;
  readonly startedAt: number;
  readonly titles: string[];
  /** The toast showing this batch while it is still open. */
  toastId: string | null;
  /** OS notification tags this batch has shown, so the single summary can replace them. */
  readonly osTags: string[];
}

/** Adds a completion to the batch that started within the window, or starts a new batch. */
export function recordCompletion(
  previous: CompletionBatch | null,
  nowMs: number,
  title: string,
): CompletionBatch {
  if (previous !== null && nowMs - previous.startedAt < COMPLETION_BATCH_WINDOW_MS) {
    previous.count += 1;
    previous.titles.push(title);
    return previous;
  }
  return { count: 1, startedAt: nowMs, titles: [title], toastId: null, osTags: [] };
}

export const completionBatchTitle = (count: number) => `${count} threads finished`;

export function completionBatchDescription(titles: ReadonlyArray<string>): string {
  const listed = titles.slice(0, MAX_LISTED_TITLES).join(", ");
  const more = titles.length - MAX_LISTED_TITLES;
  return more > 0 ? `${listed}, and ${more} more` : listed;
}
