import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { countThreadsNeedingYou } from "@t3tools/shared/threadBadge";

const epochMillisOrNull = (value: string | null | undefined) => {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The app icon's number from the threads this phone can see, counted the way the server counts
 * it for an alert, so opening a thread brings the number down without waiting for the next alert.
 */
export function appIconBadgeCount(
  threads: ReadonlyArray<
    Pick<
      EnvironmentThreadShell,
      | "archivedAt"
      | "lineage"
      | "settledOverride"
      | "snoozedUntil"
      | "hasPendingApprovals"
      | "hasPendingUserInput"
      | "runtime"
      | "latestRun"
      | "lastVisitedAt"
    >
  >,
  nowMs: number,
): number {
  return countThreadsNeedingYou(
    threads.map((thread) => ({
      archived: thread.archivedAt !== null,
      subagent: thread.lineage.relationshipToParent === "subagent",
      putAway:
        thread.settledOverride === "settled" ||
        (epochMillisOrNull(thread.snoozedUntil) ?? 0) > nowMs,
      waitingOnYou: thread.hasPendingApprovals || thread.hasPendingUserInput,
      failed: thread.runtime?.status === "failed",
      completedAtMs: epochMillisOrNull(thread.latestRun?.completedAt),
      lastVisitedAtMs: epochMillisOrNull(thread.lastVisitedAt),
    })),
  );
}
