import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarThreadStatusFilter } from "./threadStatusFilterTypes";

export * from "./threadStatusFilterTypes";

type FilterableThread = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "latestRun"
>;

/** The one non-All bucket a thread belongs to, or null (idle and waiting threads sit in none). */
export function resolveSidebarThreadFilterBucket(
  thread: FilterableThread,
): Exclude<SidebarThreadStatusFilter, "all"> | null {
  const status: SidebarThreadStatus = resolveSidebarThreadStatus(thread);
  switch (status) {
    case "working":
      return "running";
    case "approval":
    case "input":
    case "failed":
    case "limited":
      return "needs-me";
    case "ready":
      return thread.latestRun?.status === "completed" ? "done" : null;
    case "waiting":
      return null;
  }
}

export type SidebarThreadFilterCounts = Record<SidebarThreadStatusFilter, number>;

/** One pass over the threads; the All count is every thread. */
export function countSidebarThreadsByFilter(
  threads: ReadonlyArray<FilterableThread>,
): SidebarThreadFilterCounts {
  const counts: SidebarThreadFilterCounts = {
    all: threads.length,
    running: 0,
    "needs-me": 0,
    done: 0,
  };
  for (const thread of threads) {
    const bucket = resolveSidebarThreadFilterBucket(thread);
    if (bucket !== null) counts[bucket] += 1;
  }
  return counts;
}

export function filterSidebarThreadsByStatus<T extends FilterableThread>(
  threads: readonly T[],
  filter: SidebarThreadStatusFilter,
): readonly T[] {
  if (filter === "all") return threads;
  return threads.filter((thread) => resolveSidebarThreadFilterBucket(thread) === filter);
}
