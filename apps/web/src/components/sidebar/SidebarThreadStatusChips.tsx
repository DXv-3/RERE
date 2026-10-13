import { cn } from "~/lib/utils";
import {
  SIDEBAR_THREAD_STATUS_FILTERS,
  SIDEBAR_THREAD_STATUS_FILTER_LABELS,
  type SidebarThreadStatusFilter,
} from "./threadStatusFilterTypes";

/**
 * One compact row of status chips above the thread list. One chip is active at
 * a time; the row scrolls sideways rather than wrapping when the sidebar is narrow.
 */
export function SidebarThreadStatusChips({
  value,
  counts,
  onChange,
}: {
  readonly value: SidebarThreadStatusFilter;
  readonly counts: Readonly<Record<SidebarThreadStatusFilter, number>>;
  readonly onChange: (filter: SidebarThreadStatusFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter threads by status"
      className="flex items-center gap-1 overflow-x-auto px-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {SIDEBAR_THREAD_STATUS_FILTERS.map((filter) => {
        const active = value === filter;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
            className={cn(
              "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 text-2xs font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "bg-sidebar-row-selected text-sidebar-foreground"
                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          >
            {SIDEBAR_THREAD_STATUS_FILTER_LABELS[filter]}
            <span className="tabular-nums opacity-70">{counts[filter]}</span>
          </button>
        );
      })}
    </div>
  );
}
