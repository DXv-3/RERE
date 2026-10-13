import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAgentOwnedThread,
  mostRecentOrdinaryThread,
  type AgentOwnedThreads,
} from "@t3tools/client-runtime/state/agent-owned-threads";

import type { AgentView } from "./workbenchStore";

/** An ordinary thread the Threads tab can reopen. */
export interface RememberedThread {
  environmentId: string;
  threadId: string;
}

/** First path segments that look like `/$environmentId/$threadId` but are other pages. */
const RESERVED_ROOTS = new Set([
  "settings",
  "draft",
  "projects",
  "pull-requests",
  "usage",
  "welcome",
  "pair",
  "auth",
]);

const AGENT_VIEWS: ReadonlyArray<AgentView> = [
  "board",
  "checkins",
  "campaigns",
  "schedules",
  "conversation",
  "details",
];

/** The thread a path shows, or null for every other page (home, drafts, settings, usage). */
export function parseThreadPath(pathname: string): RememberedThread | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || RESERVED_ROOTS.has(parts[0]!)) return null;
  try {
    return {
      environmentId: decodeURIComponent(parts[0]!),
      threadId: decodeURIComponent(parts[1]!),
    };
  } catch {
    return null;
  }
}

export function readRememberedThread(value: unknown): RememberedThread | null {
  if (!value || typeof value !== "object") return null;
  const { environmentId, threadId } = value as Partial<RememberedThread>;
  return typeof environmentId === "string" && typeof threadId === "string" && threadId
    ? { environmentId, threadId }
    : null;
}

export function readAgentView(value: unknown): AgentView {
  return AGENT_VIEWS.includes(value as AgentView) ? (value as AgentView) : "conversation";
}

export type ThreadTabTarget =
  | { kind: "stay" }
  | { kind: "thread"; environmentId: string; threadId: string }
  | { kind: "home" };

/**
 * Where the Threads tab opens. An ordinary thread already on screen stays. Otherwise the thread
 * that was open last time comes back, as long as it still exists and is an ordinary thread. Only
 * when it does not, arriving from an agent's conversation falls back to the most recent ordinary
 * thread (or the new-thread page), and any other page is left alone.
 */
export function resolveThreadTabTarget(input: {
  pathname: string;
  remembered: RememberedThread | null;
  threads: ReadonlyArray<{
    environmentId: EnvironmentId;
    id: string;
    archivedAt: unknown;
    updatedAt: string;
    lineage?: { relationshipToParent?: unknown } | null;
  }>;
  owned: AgentOwnedThreads;
}): ThreadTabTarget {
  const current = parseThreadPath(input.pathname);
  const currentIsAgentOwned =
    current !== null &&
    isAgentOwnedThread(input.owned, current.environmentId as EnvironmentId, current.threadId);
  if (current && !currentIsAgentOwned) return { kind: "stay" };
  const { remembered } = input;
  if (
    remembered &&
    !isAgentOwnedThread(
      input.owned,
      remembered.environmentId as EnvironmentId,
      remembered.threadId,
    ) &&
    input.threads.some(
      (thread) =>
        thread.environmentId === remembered.environmentId &&
        thread.id === remembered.threadId &&
        !thread.archivedAt,
    )
  ) {
    return { kind: "thread", ...remembered };
  }
  if (!currentIsAgentOwned) return { kind: "stay" };
  const recent = mostRecentOrdinaryThread(input.threads, input.owned);
  return recent
    ? { kind: "thread", environmentId: recent.environmentId, threadId: recent.id }
    : { kind: "home" };
}

/**
 * Which Agents view opens when arriving from another tab. An agent's conversation already on
 * screen stays. Otherwise the view that was open last time returns, except a conversation with
 * no agent chosen, which has nothing to show and opens the team board.
 */
export function resolveAgentTabView(input: {
  currentIsAgentOwned: boolean;
  remembered: AgentView;
  hasSelectedAgent: boolean;
}): AgentView {
  if (input.currentIsAgentOwned) return "conversation";
  if (input.remembered === "conversation" && !input.hasSelectedAgent) return "board";
  return input.remembered;
}
