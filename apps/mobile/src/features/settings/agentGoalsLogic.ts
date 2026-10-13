import { checkGoalFields, type GoalFields } from "@t3tools/client-runtime/operations/agent-goals";
import type {
  AgentGoalAutonomy,
  EnvironmentId,
  WorkbenchAgentGoal,
  WorkspaceAgent,
} from "@t3tools/contracts";

import {
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
  type ScheduleDraft,
} from "./scheduledTaskDraft";

/** An agent record and the environment it came from. A record is only ever matched with both. */
export interface AgentEntry {
  readonly environmentId: EnvironmentId;
  readonly agent: WorkspaceAgent;
}

const isSameAgent = (
  entry: AgentEntry,
  environmentId: EnvironmentId,
  agent: Pick<WorkspaceAgent, "profile">,
) => entry.environmentId === environmentId && entry.agent.profile.id === agent.profile.id;

/**
 * A goal call returns the agent with its new revision. Take it into the held entry so the next
 * ordinary save does not conflict, unless the held copy is already newer. Only the entry for the
 * same agent in the same environment changes; a record from another machine is never mixed in.
 */
export function applyAgentToEntry<T extends AgentEntry>(
  entry: T,
  environmentId: EnvironmentId,
  agent: WorkspaceAgent,
): T {
  return isSameAgent(entry, environmentId, agent) && entry.agent.revision <= agent.revision
    ? { ...entry, agent }
    : entry;
}

export function applyAgentToEntries<T extends AgentEntry>(
  entries: ReadonlyArray<T>,
  environmentId: EnvironmentId,
  agent: WorkspaceAgent,
): T[] {
  return entries.map((entry) => applyAgentToEntry(entry, environmentId, agent));
}

/** A freshly loaded list, keeping any copy this screen already holds at a newer revision. */
export function mergeLoadedEntries<T extends AgentEntry>(
  held: ReadonlyArray<T>,
  loaded: ReadonlyArray<T>,
): T[] {
  return loaded.map((entry) => {
    const current = held.find((candidate) =>
      isSameAgent(candidate, entry.environmentId, entry.agent),
    );
    return current && current.agent.revision > entry.agent.revision ? current : entry;
  });
}

export interface GoalDraft {
  /** Null while creating. */
  readonly goalId: string | null;
  readonly title: string;
  readonly outcome: string;
  readonly autonomy: AgentGoalAutonomy;
  readonly schedule: ScheduleDraft;
}

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  goalId: null,
  title: "",
  outcome: "",
  autonomy: "propose",
  schedule: DEFAULT_SCHEDULE,
};

export function goalToDraft(goal: WorkbenchAgentGoal): GoalDraft {
  return {
    goalId: goal.id,
    title: goal.title,
    outcome: goal.outcome,
    autonomy: goal.autonomy,
    schedule: scheduleDraftForTask(goal),
  };
}

export function goalDraftToFields(draft: GoalDraft): GoalFields {
  return checkGoalFields({
    title: draft.title,
    outcome: draft.outcome,
    schedule: scheduleFromDraft(draft.schedule),
    autonomy: draft.autonomy,
  });
}

/**
 * Whether text may run past `lines` lines. A guess from length and line breaks, because the real
 * answer needs a layout pass: a few short lines never show a toggle, long text always does.
 */
export function textMayOverflow(text: string, lines: number): boolean {
  return text.length > lines * 42 || text.split("\n").length > lines;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "5 minutes ago", "2 hours ago", "3 days ago". Unreadable dates give "Earlier". */
export function ageLabel(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "Earlier";
  const elapsed = Math.max(0, now - time);
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"} ago`;
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) return unit(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return unit(Math.floor(elapsed / HOUR), "hour");
  return unit(Math.floor(elapsed / DAY), "day");
}
