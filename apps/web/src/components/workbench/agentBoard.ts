import type { EnvironmentId } from "@t3tools/contracts";

import type { ThreadShell } from "../../types";
import {
  hasPlanReadyPrompt,
  resolveSidebarThreadQuietMinutes,
  resolveSidebarThreadStatus,
} from "../Sidebar.logic";

/** Highest priority first; this is also the order of the board. */
const AGENT_BOARD_STATUSES = [
  "needs-you",
  "failed",
  "limited",
  "working",
  "idle",
  "not-started",
] as const;

export type AgentBoardStatus = (typeof AGENT_BOARD_STATUSES)[number];

/** Why an agent needs the user, so the row can say more than "Needs You". */
export type AgentBoardNeed = "approval" | "input" | "plan";

export const AGENT_BOARD_STATUS_LABEL: Record<AgentBoardStatus, string> = {
  "needs-you": "Needs You",
  failed: "Failed",
  limited: "Limited",
  working: "Working",
  idle: "Idle",
  "not-started": "Not Started",
};

// The summary line reads "2 Need You", where the row badge reads "Needs You".
const SUMMARY_LABEL: Record<AgentBoardStatus, string> = {
  ...AGENT_BOARD_STATUS_LABEL,
  "needs-you": "Need You",
};

export const AGENT_BOARD_NEED_LABEL: Record<AgentBoardNeed, string> = {
  approval: "Approval Pending",
  input: "Question Waiting",
  plan: "Plan To Review",
};

export type AgentBoardThread = Pick<
  ThreadShell,
  | "environmentId"
  | "id"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "updatedAt"
  | "latestUserMessageAt"
  | "activeRunRequestedBy"
>;

export interface AgentBoardAgent {
  readonly id: string;
  readonly name: string;
  readonly primaryThreadId?: string | null | undefined;
  /** Every conversation the agent owns, so a message sent from a side thread still names it. */
  readonly threadIds?: ReadonlyArray<string> | undefined;
}

export interface AgentBoardEntry<TAgent extends AgentBoardAgent> {
  readonly agent: TAgent;
  readonly status: AgentBoardStatus;
  readonly need: AgentBoardNeed | null;
  /** Latest sign of life in the conversation; null when there is none to report. */
  readonly lastActivityAt: string | null;
  /** Set when the conversation lives on another machine than this device. */
  readonly remoteEnvironmentId: EnvironmentId | null;
  /** Goal check-ins waiting for the owner. Shown on the row; it does not change the order. */
  readonly pendingCheckIns: number;
  /** Minutes a working agent has produced nothing, once past ten; null otherwise. */
  readonly quietMinutes: number | null;
  /** Name of the agent whose message the live run is answering; null when a person asked. */
  readonly askedBy: string | null;
  /** Names of the agents currently working on a message this agent sent. */
  readonly waitingOn: ReadonlyArray<string>;
}

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const threadKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

function latestTimestamp(thread: AgentBoardThread): string | null {
  const candidates = [thread.updatedAt, thread.latestUserMessageAt, thread.runtime?.updatedAt];
  let best: { ms: number; value: string } | null = null;
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) continue;
    if (!best || ms > best.ms) best = { ms, value };
  }
  return best?.value ?? null;
}

/**
 * Status comes from the same derivation as the sidebar pill, folded into six groups: approvals,
 * questions and plans waiting on the user are Needs You; a running or waiting turn is Working.
 */
function resolveAgentBoardStatus(thread: AgentBoardThread): {
  status: AgentBoardStatus;
  need: AgentBoardNeed | null;
} {
  const sidebar = resolveSidebarThreadStatus(thread);
  if (sidebar === "approval") return { status: "needs-you", need: "approval" };
  if (sidebar === "input") return { status: "needs-you", need: "input" };
  if (hasPlanReadyPrompt(thread)) return { status: "needs-you", need: "plan" };
  if (sidebar === "failed") return { status: "failed", need: null };
  if (sidebar === "limited") return { status: "limited", need: null };
  if (sidebar === "working" || sidebar === "waiting") return { status: "working", need: null };
  return { status: "idle", need: null };
}

/**
 * One entry per agent, ordered for the board. The conversation is the live one when sync knows
 * it (it may be on another environment), else the agent's primary thread in the workspace
 * environment. An agent with no conversation is Not Started; one whose thread has not loaded yet
 * reads Idle with no activity rather than claiming it never started.
 */
export function buildAgentBoard<TAgent extends AgentBoardAgent>(input: {
  agents: ReadonlyArray<TAgent>;
  threads: ReadonlyArray<AgentBoardThread>;
  workspaceEnvironmentId: EnvironmentId;
  /** Where each agent's live conversation is; empty when agent sync is off. */
  live?: Readonly<
    Record<string, { readonly environmentId: EnvironmentId; readonly threadId: string }>
  >;
  /** This device's environment. */
  localEnvironmentId: EnvironmentId | null;
  /** Check-ins waiting for review, by agent id. */
  pendingCheckIns?: Readonly<Record<string, number>>;
  /** Clock for quiet detection; callers refresh it once a minute. */
  nowMs?: number;
}): AgentBoardEntry<TAgent>[] {
  const byKey = new Map<string, AgentBoardThread>();
  for (const thread of input.threads) byKey.set(threadKey(thread.environmentId, thread.id), thread);

  const threadByAgent = new Map<string, AgentBoardThread>();
  const entries = input.agents.map((agent): AgentBoardEntry<TAgent> => {
    const pendingCheckIns = input.pendingCheckIns?.[agent.id] ?? 0;
    const live = input.live?.[agent.id];
    const candidates = [
      live ? { environmentId: live.environmentId, threadId: live.threadId } : null,
      agent.primaryThreadId
        ? { environmentId: input.workspaceEnvironmentId, threadId: agent.primaryThreadId }
        : null,
    ].filter((candidate) => candidate !== null);
    if (candidates.length === 0) {
      return {
        agent,
        status: "not-started",
        need: null,
        lastActivityAt: null,
        remoteEnvironmentId: null,
        pendingCheckIns,
        quietMinutes: null,
        askedBy: null,
        waitingOn: [],
      };
    }
    const found = candidates
      .map((c) => ({ ...c, thread: byKey.get(threadKey(c.environmentId, c.threadId)) }))
      .find((c) => c.thread !== undefined);
    const where = found ?? candidates[0]!;
    const remoteEnvironmentId =
      input.localEnvironmentId !== null && where.environmentId !== input.localEnvironmentId
        ? where.environmentId
        : null;
    if (!found?.thread) {
      return {
        agent,
        status: "idle",
        need: null,
        lastActivityAt: null,
        remoteEnvironmentId,
        pendingCheckIns,
        quietMinutes: null,
        askedBy: null,
        waitingOn: [],
      };
    }
    threadByAgent.set(agent.id, found.thread);
    return {
      agent,
      ...resolveAgentBoardStatus(found.thread),
      lastActivityAt: latestTimestamp(found.thread),
      remoteEnvironmentId,
      pendingCheckIns,
      quietMinutes:
        input.nowMs === undefined
          ? null
          : resolveSidebarThreadQuietMinutes(found.thread, input.nowMs),
      askedBy: null,
      waitingOn: [],
    };
  });

  // Who asked whom comes from the shells alone: a working agent's live run names the thread of
  // the agent that messaged it, and that thread resolves to an agent here. The asker "waits on" it
  // for as long as it works, which is when an answer is on its way back.
  const agentByThread = new Map<string, TAgent>();
  for (const agent of input.agents) {
    for (const id of [
      agent.primaryThreadId,
      input.live?.[agent.id]?.threadId,
      ...(agent.threadIds ?? []),
    ]) {
      if (id) agentByThread.set(id, agent);
    }
  }
  const waitingOn = new Map<string, string[]>();
  const withRequester = entries.map((entry): AgentBoardEntry<TAgent> => {
    const shell = threadByAgent.get(entry.agent.id);
    const requesterThread = shell?.activeRunRequestedBy?.threadId;
    const active = shell?.runtime ? ACTIVE_RUNTIME_STATUSES.has(shell.runtime.status) : false;
    const asker = requesterThread && active ? agentByThread.get(requesterThread) : undefined;
    if (!asker || asker.id === entry.agent.id) return entry;
    waitingOn.set(asker.id, [...(waitingOn.get(asker.id) ?? []), entry.agent.name]);
    return { ...entry, askedBy: asker.name };
  });
  const resolved = withRequester.map((entry) => {
    const names = waitingOn.get(entry.agent.id);
    return names ? { ...entry, waitingOn: names.toSorted((a, b) => a.localeCompare(b)) } : entry;
  });

  const rank = (status: AgentBoardStatus) => AGENT_BOARD_STATUSES.indexOf(status);
  const time = (entry: AgentBoardEntry<TAgent>) =>
    entry.lastActivityAt === null ? Number.NEGATIVE_INFINITY : Date.parse(entry.lastActivityAt);
  return resolved.toSorted(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      // -Infinity - -Infinity is NaN, so compare explicitly.
      (time(a) === time(b) ? 0 : time(b) > time(a) ? 1 : -1) ||
      a.agent.name.localeCompare(b.agent.name),
  );
}

export function summarizeAgentBoard(entries: ReadonlyArray<{ status: AgentBoardStatus }>): {
  counts: Record<AgentBoardStatus, number>;
  label: string;
} {
  const counts = Object.fromEntries(AGENT_BOARD_STATUSES.map((s) => [s, 0])) as Record<
    AgentBoardStatus,
    number
  >;
  for (const entry of entries) counts[entry.status] += 1;
  const label = AGENT_BOARD_STATUSES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${SUMMARY_LABEL[s]}`)
    .join(" · ");
  return { counts, label };
}
