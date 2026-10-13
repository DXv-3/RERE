import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export const SESSION_FILTER_CHOICES = [
  { value: "all", title: "All" },
  { value: "needs-attention", title: "Needs attention" },
  { value: "awaiting-review", title: "Awaiting review" },
  { value: "awaiting-answer", title: "Awaiting answer" },
] as const;

export type SessionFilter = (typeof SESSION_FILTER_CHOICES)[number]["value"];

export function isSessionFilter(value: unknown): value is SessionFilter {
  return SESSION_FILTER_CHOICES.some((choice) => choice.value === value);
}

/** Shell flags are authoritative across providers; completion/unread is not a review request. */
export function matchesSessionFilter(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "hasActionableProposedPlan"
  >,
  filter: SessionFilter,
): boolean {
  const review = thread.hasPendingApprovals || thread.hasActionableProposedPlan;
  switch (filter) {
    case "all":
      return true;
    case "needs-attention":
      return review || thread.hasPendingUserInput;
    case "awaiting-review":
      return review;
    case "awaiting-answer":
      return thread.hasPendingUserInput;
  }
}

export function sessionFilterEmptyTitle(filter: SessionFilter): string {
  switch (filter) {
    case "all":
      return "No threads yet";
    case "needs-attention":
      return "No sessions need attention";
    case "awaiting-review":
      return "No sessions awaiting review";
    case "awaiting-answer":
      return "No sessions awaiting an answer";
  }
}
