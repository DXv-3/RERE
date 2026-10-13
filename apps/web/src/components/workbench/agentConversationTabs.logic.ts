import type { SidebarThreadStatus } from "../Sidebar.logic";

/** Longest title a tab shows before it is cut; the tooltip carries the full text. */
const TAB_TITLE_LIMIT = 28;

/** Fired by the tab strip's "+"; the Agents workspace owns thread creation and answers it. */
export const NEW_AGENT_CONVERSATION_EVENT = "workbench:new-agent-conversation";
export interface NewAgentConversationRequest {
  environmentId: string;
  agentId: string;
  /** Called once the conversation was opened or the attempt gave up. */
  done: () => void;
}

/** Quiet by default: only a conversation that needs a look gets a dot. */
export type AgentTabDot = "working" | "needs-you" | "failed" | "done";

export interface AgentTabThread {
  id: string;
  title: string;
  archivedAt?: unknown;
  status: SidebarThreadStatus;
  isUnread: boolean;
}

export interface AgentConversationTab {
  id: string;
  /** Short text for the tab itself. */
  label: string;
  /** Full text for the tooltip and screen readers. */
  fullTitle: string;
  dot: AgentTabDot | null;
  /** Any conversation can be closed while the agent has another to fall back to. */
  closable: boolean;
}

/** Same grouping as the team board: approvals and questions need the user, a live turn is working. */
export function resolveAgentTabDot(
  status: SidebarThreadStatus,
  isUnread: boolean,
): AgentTabDot | null {
  if (status === "approval" || status === "input") return "needs-you";
  if (status === "working" || status === "waiting") return "working";
  if (status === "failed" || status === "limited") return "failed";
  return isUnread ? "done" : null;
}

export function truncateTabTitle(title: string, limit = TAB_TITLE_LIMIT): string {
  const plain = title.replace(/\s+/g, " ").trim();
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * New conversations start out titled with the agent's name, which says nothing in a row of tabs
 * that all belong to the same agent. An additional conversation still carrying that name is new.
 */
export function agentTabTitle(input: {
  title: string;
  agentName: string;
  isPrimary: boolean;
}): string {
  const title = input.title.trim();
  if (!input.isPrimary && (title === "" || title === input.agentName.trim())) return "New chat";
  return title || input.agentName.trim() || "Conversation";
}

/** Primary first, then the additional conversations in the order they were made. Archived and unknown threads are left out. */
export function buildAgentConversationTabs(input: {
  agentName: string;
  primaryThreadId: string | null | undefined;
  threadIds: ReadonlyArray<string> | undefined;
  threads: ReadonlyArray<AgentTabThread>;
}): AgentConversationTab[] {
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const ordered = [...new Set([input.primaryThreadId, ...(input.threadIds ?? [])])].filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  const openCount = ordered.filter((id) => {
    const thread = byId.get(id);
    return thread !== undefined && !thread.archivedAt;
  }).length;
  return ordered.flatMap((id) => {
    const thread = byId.get(id);
    if (!thread || thread.archivedAt) return [];
    const isPrimary = id === input.primaryThreadId;
    const fullTitle = agentTabTitle({ title: thread.title, agentName: input.agentName, isPrimary });
    return [
      {
        id,
        label: truncateTabTitle(fullTitle),
        fullTitle,
        dot: resolveAgentTabDot(thread.status, thread.isUnread),
        closable: openCount > 1,
      },
    ];
  });
}

/**
 * The agent's conversations once `closedId` is closed. Closing the main conversation hands that
 * role to the first one left, so the agent always has somewhere for messages to land.
 */
export function agentThreadsAfterClose(input: {
  primaryThreadId: string | null | undefined;
  threadIds: ReadonlyArray<string> | undefined;
  /** Open tabs in display order, before closing. */
  tabIds: ReadonlyArray<string>;
  closedId: string;
}): { primaryThreadId: string | null; threadIds: string[]; primaryChanged: boolean } {
  const remaining = input.tabIds.filter((id) => id !== input.closedId);
  const primaryChanged = input.primaryThreadId === input.closedId;
  const primaryThreadId = primaryChanged ? (remaining[0] ?? null) : (input.primaryThreadId ?? null);
  return {
    primaryThreadId,
    threadIds: (input.threadIds ?? []).filter((id) => id !== input.closedId),
    primaryChanged,
  };
}

/** The tab to show once `closedId` is gone: stay put unless it was the open one, then go left. */
export function selectAfterClose(input: {
  tabIds: ReadonlyArray<string>;
  closedId: string;
  activeId: string | null;
}): string | null {
  const remaining = input.tabIds.filter((id) => id !== input.closedId);
  if (input.activeId !== input.closedId) return input.activeId;
  const index = input.tabIds.indexOf(input.closedId);
  if (index < 0) return remaining[0] ?? null;
  return remaining[Math.min(index - 1, remaining.length - 1)] ?? remaining[0] ?? null;
}

/** The remembered conversation if it still has a tab, otherwise the primary one. */
export function resolveRememberedConversation(input: {
  remembered: string | null | undefined;
  tabIds: ReadonlyArray<string>;
  primaryThreadId: string | null | undefined;
}): string | null {
  if (input.remembered && input.tabIds.includes(input.remembered)) return input.remembered;
  return input.primaryThreadId ?? null;
}

/** Which tab arrow keys, Home and End move to. Null for any other key. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
