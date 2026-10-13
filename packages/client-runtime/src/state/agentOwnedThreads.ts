/**
 * Which threads belong to a workspace agent.
 *
 * An agent's conversations are ordinary threads whose ids the server records on
 * the agent, so the server's list is the one source of truth that is the same on
 * every device. Clients use it to keep those threads out of the normal Threads
 * list ("agents show in Agents, threads are sessions").
 *
 * @module state/agentOwnedThreads
 */
import type { EnvironmentId, WorkspaceAgent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export type AgentOwnedThreads = ReadonlyMap<EnvironmentId, ReadonlySet<string>>;

const EMPTY: AgentOwnedThreads = new Map();

/** Every agent's primary thread and recorded threads, archived agents included. */
export function agentOwnedThreadIds(agents: ReadonlyArray<WorkspaceAgent>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (agent.primaryThreadId) ids.add(agent.primaryThreadId);
    for (const threadId of agent.threadIds ?? []) ids.add(threadId);
  }
  return ids;
}

export function isAgentOwnedThread(
  owned: AgentOwnedThreads,
  environmentId: EnvironmentId,
  threadId: string,
): boolean {
  return owned.get(environmentId)?.has(threadId) === true;
}

/** Same list with agent-owned threads removed; returns the input when nothing is removed. */
export function withoutAgentOwnedThreads<T extends { environmentId: EnvironmentId; id: string }>(
  threads: ReadonlyArray<T>,
  owned: AgentOwnedThreads,
): ReadonlyArray<T> {
  if (owned.size === 0) return threads;
  const visible = threads.filter(
    (thread) => !isAgentOwnedThread(owned, thread.environmentId, thread.id),
  );
  return visible.length === threads.length ? threads : visible;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * One derived map over the given environments, built from one shared agent-list
 * query per environment. Environments whose list has not loaded, or failed, are
 * absent so callers keep showing their threads. Unchanged sets keep their
 * identity, so the periodic refresh does not re-render thread lists.
 */
export function createAgentOwnedThreadsAtom(input: {
  readonly agentList: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<WorkspaceAgent>, unknown>>;
  readonly environmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
}) {
  return Atom.make((get): AgentOwnedThreads => {
    const previous = Option.getOrNull(get.self<AgentOwnedThreads>()) ?? EMPTY;
    const next = new Map<EnvironmentId, ReadonlySet<string>>();
    for (const environmentId of get(input.environmentIdsAtom)) {
      const agents = Option.getOrNull(
        AsyncResult.value(get(input.agentList({ environmentId, input: {} }))),
      );
      if (agents === null) continue;
      const ids = agentOwnedThreadIds(agents);
      const prior = previous.get(environmentId);
      next.set(environmentId, prior !== undefined && sameIds(prior, ids) ? prior : ids);
    }
    if (next.size === 0) return EMPTY;
    return previous.size === next.size && [...next].every(([id, set]) => previous.get(id) === set)
      ? previous
      : next;
  }).pipe(Atom.withLabel("agent-owned-threads"));
}

/**
 * The ordinary thread to show when leaving an agent's conversation for the Threads view: the one
 * most recently active that is not an agent's, not archived and not a subagent. Null when there
 * is none, in which case the caller opens a new thread.
 */
export function mostRecentOrdinaryThread<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly archivedAt: unknown;
    readonly updatedAt: string;
    readonly lineage?: { readonly relationshipToParent?: unknown } | null;
  },
>(threads: ReadonlyArray<T>, owned: AgentOwnedThreads): T | null {
  let latest: T | null = null;
  for (const thread of withoutAgentOwnedThreads(threads, owned)) {
    if (thread.archivedAt) continue;
    if (thread.lineage?.relationshipToParent === "subagent") continue;
    if (latest === null || thread.updatedAt > latest.updatedAt) latest = thread;
  }
  return latest;
}
