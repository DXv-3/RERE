/**
 * The number on the app icon: threads that need the person. The server sends it with each phone
 * alert and the phone sets it while open, so both count the same threads the same way. Each side
 * maps its own thread shape into `ThreadBadgeInput`.
 */
export interface ThreadBadgeInput {
  readonly archived: boolean;
  /** A provider-run subagent; its parent thread speaks for it. */
  readonly subagent: boolean;
  /** Settled or snoozed: the person put it away. */
  readonly putAway: boolean;
  /** An approval or a question is waiting. */
  readonly waitingOnYou: boolean;
  readonly failed: boolean;
  readonly completedAtMs: number | null;
  readonly lastVisitedAtMs: number | null;
}

/**
 * Whether a thread counts. A finished run counts until the thread is opened after it, matching
 * the phone's "Done" label: a thread never opened has no visit to compare with and is not counted.
 */
export function threadNeedsYou(thread: ThreadBadgeInput): boolean {
  if (thread.archived || thread.subagent) return false;
  if (thread.waitingOnYou) return true;
  if (thread.putAway) return false;
  if (thread.failed) return true;
  return (
    thread.completedAtMs !== null &&
    thread.lastVisitedAtMs !== null &&
    thread.completedAtMs > thread.lastVisitedAtMs
  );
}

export function countThreadsNeedingYou(threads: ReadonlyArray<ThreadBadgeInput>): number {
  let count = 0;
  for (const thread of threads) if (threadNeedsYou(thread)) count += 1;
  return count;
}
