export const SIDEBAR_THREAD_STATUS_FILTERS = ["all", "running", "needs-me", "done"] as const;
export type SidebarThreadStatusFilter = (typeof SIDEBAR_THREAD_STATUS_FILTERS)[number];

export const SIDEBAR_THREAD_STATUS_FILTER_LABELS: Record<SidebarThreadStatusFilter, string> = {
  all: "All",
  running: "Running",
  "needs-me": "Needs Me",
  done: "Done",
};

export function isSidebarThreadStatusFilter(value: unknown): value is SidebarThreadStatusFilter {
  return SIDEBAR_THREAD_STATUS_FILTERS.includes(value as SidebarThreadStatusFilter);
}
