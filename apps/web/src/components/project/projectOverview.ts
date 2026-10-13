import type { ThreadPullRequestLink } from "@t3tools/contracts";

import type { ThreadShell } from "../../types";
import {
  hasPlanReadyPrompt,
  isSidebarThreadShelvedAsSettled,
  resolveSidebarThreadStatus,
} from "../Sidebar.logic";

/** The order the Overview lists them in: what needs the user first, finished work last. */
export const PROJECT_OVERVIEW_GROUPS = [
  "waiting",
  "review",
  "working",
  "landing",
  "idle",
  "resolved",
] as const;

export type ProjectOverviewGroup = (typeof PROJECT_OVERVIEW_GROUPS)[number];

export const PROJECT_OVERVIEW_GROUP_LABEL: Record<ProjectOverviewGroup, string> = {
  waiting: "Waiting On You",
  review: "Ready For Review",
  working: "Working",
  landing: "Landing",
  idle: "Idle",
  resolved: "Resolved",
};

/** Why a thread is waiting on the user, so its row can say more than the group name. */
export type ProjectOverviewNeed = "approval" | "input" | "plan" | "failed" | "limited";

export const PROJECT_OVERVIEW_NEED_LABEL: Record<ProjectOverviewNeed, string> = {
  approval: "Approval Pending",
  input: "Question Waiting",
  plan: "Plan To Review",
  failed: "Failed",
  limited: "Usage Limit Reached",
};

export type ProjectOverviewThread = Pick<
  ThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "archivedAt"
  | "settledOverride"
  | "lineage"
  | "pullRequests"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "updatedAt"
>;

export interface ProjectOverviewEntry<TThread extends ProjectOverviewThread> {
  readonly thread: TThread;
  readonly group: ProjectOverviewGroup;
  readonly need: ProjectOverviewNeed | null;
  /** The pull request that put the thread in Ready For Review or Landing; else its newest open one. */
  readonly pullRequest: ThreadPullRequestLink | null;
}

const isOpen = (link: ThreadPullRequestLink) =>
  link.source !== "stack-dismissed" && link.snapshot?.state === "open";

/**
 * Which group a thread belongs to. What the user must act on outranks everything, live work
 * outranks a pull request's state, and a thread the user settled is Resolved even when its pull
 * request is still open: they said they were done with it.
 */
export function resolveProjectOverviewEntry<TThread extends ProjectOverviewThread>(
  thread: TThread,
): ProjectOverviewEntry<TThread> {
  const open = thread.pullRequests.filter(isOpen);
  const approved = open.find((link) => link.snapshot?.reviewDecision === "approved") ?? null;
  const reviewable = open.find((link) => link.snapshot?.isDraft === false) ?? null;
  const pullRequest = approved ?? reviewable ?? open[0] ?? null;
  const entry = (group: ProjectOverviewGroup, need: ProjectOverviewNeed | null = null) => ({
    thread,
    group,
    need,
    pullRequest,
  });

  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return entry("waiting", "approval");
  if (status === "input") return entry("waiting", "input");
  if (hasPlanReadyPrompt(thread)) return entry("waiting", "plan");
  if (status === "failed") return entry("waiting", "failed");
  if (status === "limited") return entry("waiting", "limited");
  if (status === "working" || status === "waiting") return entry("working");
  if (isSidebarThreadShelvedAsSettled(thread)) return entry("resolved");
  if (approved !== null) return entry("landing");
  if (reviewable !== null) return entry("review");
  return entry("idle");
}

/**
 * A project's threads sorted into the Overview's groups, most recently active first within each.
 * Archived threads and provider-made subagent threads are left out, and so is the coordinator:
 * it is the conversation the Overview sits beside, not a piece of work.
 */
export function buildProjectOverview<TThread extends ProjectOverviewThread>(input: {
  readonly threads: ReadonlyArray<TThread>;
  /** One per machine the project lives on. */
  readonly coordinatorThreadIds?: ReadonlySet<string> | undefined;
}): Record<ProjectOverviewGroup, ReadonlyArray<ProjectOverviewEntry<TThread>>> {
  const groups = Object.fromEntries(
    PROJECT_OVERVIEW_GROUPS.map((group) => [group, [] as ProjectOverviewEntry<TThread>[]]),
  ) as Record<ProjectOverviewGroup, ProjectOverviewEntry<TThread>[]>;
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (thread.lineage.relationshipToParent === "subagent") continue;
    if (input.coordinatorThreadIds?.has(thread.id)) continue;
    const entry = resolveProjectOverviewEntry(thread);
    groups[entry.group].push(entry);
  }
  const time = (entry: ProjectOverviewEntry<TThread>) => Date.parse(entry.thread.updatedAt) || 0;
  for (const group of PROJECT_OVERVIEW_GROUPS) {
    groups[group].sort((a, b) => time(b) - time(a) || a.thread.title.localeCompare(b.thread.title));
  }
  return groups;
}

/** "2 Waiting On You · 1 Working", skipping empty groups; empty when there are no threads. */
export function summarizeProjectOverview(
  groups: Record<ProjectOverviewGroup, ReadonlyArray<unknown>>,
): string {
  return PROJECT_OVERVIEW_GROUPS.filter((group) => groups[group].length > 0)
    .map((group) => `${groups[group].length} ${PROJECT_OVERVIEW_GROUP_LABEL[group]}`)
    .join(" · ");
}

/**
 * The threads a pause must stop: everything with a live run, the coordinator included. Archived
 * threads and provider-made subagents are left alone; a subagent stops with its parent.
 */
export function threadsToInterruptOnPause<
  TThread extends Pick<
    ProjectOverviewThread,
    "archivedAt" | "lineage" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
  >,
>(threads: ReadonlyArray<TThread>): ReadonlyArray<TThread> {
  return threads.filter((thread) => {
    if (thread.archivedAt !== null) return false;
    if (thread.lineage.relationshipToParent === "subagent") return false;
    const status = resolveSidebarThreadStatus(thread);
    // A thread stopped at an approval or a question still holds a live run.
    return (
      status === "working" || status === "waiting" || status === "approval" || status === "input"
    );
  });
}
