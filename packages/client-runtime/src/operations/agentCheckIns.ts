import type { AgentCheckIn, AgentCheckInStatus, WorkspaceAgent } from "@t3tools/contracts";

export type CheckInFilter = "waiting" | "all";

export const CHECKIN_STATUS_LABEL: Record<AgentCheckInStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  redirected: "Redirected",
  dismissed: "Dismissed",
};

const byNewest = (a: AgentCheckIn, b: AgentCheckIn) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);

/** Replaces check-ins with a newer copy of the same id, such as one just reviewed here. */
export function applyReviewed(
  checkIns: ReadonlyArray<AgentCheckIn>,
  reviewed: Readonly<Record<string, AgentCheckIn>>,
): AgentCheckIn[] {
  return checkIns.map((checkIn) => reviewed[checkIn.id] ?? checkIn);
}

/**
 * What the inbox lists. Waiting is the pending stream alone. All puts everything waiting first,
 * then reviewed history; each group is newest first. The two streams overlap, so ids are deduped
 * with the pending stream winning, since it is the one that reports a review first.
 */
export function arrangeCheckIns(input: {
  filter: CheckInFilter;
  pending: ReadonlyArray<AgentCheckIn>;
  all: ReadonlyArray<AgentCheckIn>;
}): AgentCheckIn[] {
  const waiting = input.pending.filter((checkIn) => checkIn.status === "pending");
  if (input.filter === "waiting") return [...waiting].sort(byNewest);
  const waitingIds = new Set(waiting.map((checkIn) => checkIn.id));
  const history = input.all.filter(
    (checkIn) => checkIn.status !== "pending" && !waitingIds.has(checkIn.id),
  );
  return [...[...waiting].sort(byNewest), ...[...history].sort(byNewest)];
}

export function countPendingByAgent(
  checkIns: ReadonlyArray<Pick<AgentCheckIn, "agentId" | "status">>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const checkIn of checkIns) {
    if (checkIn.status === "pending") counts[checkIn.agentId] = (counts[checkIn.agentId] ?? 0) + 1;
  }
  return counts;
}

/** "1 Check-In Waiting", "3 Check-Ins Waiting"; `more` marks a count that stops at the first page. */
export function checkInsWaitingLabel(count: number, more = false): string {
  const number = more ? `${count}+` : String(count);
  return `${number} ${count === 1 && !more ? "Check-In" : "Check-Ins"} Waiting`;
}

/** The goal a check-in reports on, or null once the goal was deleted. The check-in itself is kept. */
export function goalTitleFor(
  agents: ReadonlyArray<Pick<WorkspaceAgent, "profile" | "goals">>,
  checkIn: Pick<AgentCheckIn, "agentId" | "goalId">,
): string | null {
  const agent = agents.find((entry) => entry.profile.id === checkIn.agentId);
  return agent?.goals?.find((goal) => goal.id === checkIn.goalId)?.title ?? null;
}

export type RedirectNote = { readonly ok: true; readonly note: string } | { readonly ok: false };

/** A redirect is an instruction to the agent, so it needs words. */
export function checkRedirectNote(raw: string): RedirectNote {
  const note = raw.trim();
  return note === "" ? { ok: false } : { ok: true, note };
}
