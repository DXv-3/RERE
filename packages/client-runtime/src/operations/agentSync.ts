import type { WorkspaceAgent } from "@t3tools/contracts";

import {
  planAgentMove,
  sameValue,
  type AgentMoveProject,
  type AgentMoveProvider,
} from "./agentMove.ts";

/**
 * Keeps one agent equal on two environments without asking. The client sits between two servers
 * that never talk to each other, so it remembers what both sides agreed on last time (the base)
 * and merges each field against it. Timestamps cannot decide on their own: every save restamps
 * `updatedAt` on the server, so a newer-wins rule alone would copy back and forth forever.
 *
 * Model, project and imported history are set when an agent is first created on the other side
 * and stay per environment afterwards. Conversation links never leave their environment.
 */

const PROFILE_FIELDS = [
  "name",
  "description",
  "instructions",
  "color",
  "pinned",
  "runtimeMode",
  "avatar",
  "blockedToolGroups",
] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
export type AgentSyncField = ProfileField | "recovery" | "archived";
type AgentMemory = WorkspaceAgent["memories"][number];

const MEMORY_LIMIT = 100;

/** What both sides held for an agent after the last successful sync. Stored as JSON. */
export interface AgentSyncBase {
  /** A field missing here has never been equal on both sides. */
  readonly fields: Partial<Record<AgentSyncField, unknown>>;
  readonly memories: Readonly<Record<string, AgentMemory>>;
}

export interface AgentSyncSide {
  readonly agents: ReadonlyArray<WorkspaceAgent>;
  readonly projects: ReadonlyArray<AgentMoveProject>;
  readonly providers: ReadonlyArray<AgentMoveProvider>;
}

export interface AgentSyncSave {
  readonly side: "local" | "remote";
  readonly record: WorkspaceAgent;
  /** 0 creates the record, otherwise the revision the save must replace. */
  readonly expectedRevision: number;
}

export interface AgentSyncStep {
  readonly agentId: string;
  readonly name: string;
  readonly saves: ReadonlyArray<AgentSyncSave>;
  /** Store this once every save above succeeded; a failed save keeps the old base. */
  readonly nextBase: AgentSyncBase;
  /** Fields that differ with no shared history to say which is newer. Both sides keep their own. */
  readonly unresolved: ReadonlyArray<AgentSyncField>;
}

// The server returns an image both inline and by content hash; the hash alone identifies it.
function comparable(field: AgentSyncField, agent: WorkspaceAgent): unknown {
  if (field === "archived") return Boolean(agent.archivedAt);
  if (field === "recovery") return agent.recovery;
  // An empty list and a missing one both mean everything is allowed, and nothing set reads as
  // null so a first meeting carries the restricted side's switches across.
  if (field === "blockedToolGroups") {
    const blocked = agent.profile.blockedToolGroups;
    return blocked && blocked.length > 0 ? [...blocked].sort() : null;
  }
  if (field === "avatar") {
    const avatar = agent.profile.avatar;
    if (!avatar) return null;
    return avatar.imageRef ? { ...avatar, image: null } : avatar;
  }
  return agent.profile[field];
}

function baseOf(agent: WorkspaceAgent): AgentSyncBase {
  const fields: Partial<Record<AgentSyncField, unknown>> = {};
  for (const field of [...PROFILE_FIELDS, "recovery", "archived"] as const) {
    fields[field] = comparable(field, agent);
  }
  return {
    fields,
    memories: Object.fromEntries(agent.memories.map((memory) => [memory.id, memory])),
  };
}

/**
 * Settles fields that differ with no shared history: the returned base records the losing
 * side's values, so the next plan sees only the kept side as changed and copies it across.
 */
export function baseKeeping(
  base: AgentSyncBase | undefined,
  loser: WorkspaceAgent,
  fields: ReadonlyArray<AgentSyncField>,
): AgentSyncBase {
  const next = { ...base?.fields };
  for (const field of fields) next[field] = comparable(field, loser);
  return { fields: next, memories: base?.memories ?? {} };
}

const isNewer = (a: WorkspaceAgent, b: WorkspaceAgent) =>
  (Date.parse(a.updatedAt) || 0) >= (Date.parse(b.updatedAt) || 0);

type Winner = "same" | "local" | "remote" | "unresolved";

function pickWinner(
  field: AgentSyncField,
  local: WorkspaceAgent,
  remote: WorkspaceAgent,
  base: AgentSyncBase | undefined,
): Winner {
  const a = comparable(field, local);
  const b = comparable(field, remote);
  if (sameValue(a, b)) return "same";
  if (base && field in base.fields) {
    const was = base.fields[field];
    if (sameValue(a, was)) return "remote";
    if (sameValue(b, was)) return "local";
  } else {
    // First meeting. An agent hidden on one side only was moved, not retired, so it stays visible.
    if (field === "archived") return a ? "remote" : "local";
    if (a === null) return "remote";
    if (b === null) return "local";
    if (field !== "recovery") return "unresolved";
  }
  if (field === "recovery") {
    // The side confirmed most recently wins, so a resumed agent is never re-blocked by a stale copy.
    const confirmedA = Date.parse(local.recovery.verifiedAt ?? "") || 0;
    const confirmedB = Date.parse(remote.recovery.verifiedAt ?? "") || 0;
    if (confirmedA !== confirmedB) return confirmedA > confirmedB ? "local" : "remote";
  }
  return isNewer(local, remote) ? "local" : "remote";
}

function mergeMemories(
  local: WorkspaceAgent,
  remote: WorkspaceAgent,
  base: AgentSyncBase | undefined,
): ReadonlyArray<AgentMemory> {
  const mine = new Map(local.memories.map((memory) => [memory.id, memory]));
  const theirs = new Map(remote.memories.map((memory) => [memory.id, memory]));
  const localWins = isNewer(local, remote);
  const merged: AgentMemory[] = [];
  for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(id);
    const b = theirs.get(id);
    const was = base?.memories[id];
    let kept: AgentMemory | undefined;
    if (a && b) {
      if (sameValue(a, b)) kept = a;
      else if (was && sameValue(a, was)) kept = b;
      else if (was && sameValue(b, was)) kept = a;
      else kept = localWins ? a : b;
    } else {
      // Missing on one side: a removal only when it was shared before and not edited since.
      const present = (a ?? b)!;
      kept = was && sameValue(present, was) ? undefined : present;
    }
    if (kept) merged.push(kept);
  }
  return merged.slice(0, MEMORY_LIMIT);
}

function planPair(
  local: WorkspaceAgent,
  remote: WorkspaceAgent,
  base: AgentSyncBase | undefined,
): AgentSyncStep {
  const unresolved: AgentSyncField[] = [];
  const fields: Partial<Record<AgentSyncField, unknown>> = {};
  let nextLocal = local;
  let nextRemote = remote;
  const take = (field: AgentSyncField, from: WorkspaceAgent, onto: WorkspaceAgent) =>
    field === "recovery"
      ? { ...onto, recovery: from.recovery }
      : field === "archived"
        ? { ...onto, archivedAt: from.archivedAt ?? null }
        : field === "blockedToolGroups"
          ? // Written out even when empty: a save that leaves the field out keeps what is stored.
            {
              ...onto,
              profile: { ...onto.profile, blockedToolGroups: from.profile.blockedToolGroups ?? [] },
            }
          : { ...onto, profile: { ...onto.profile, [field]: from.profile[field] } };

  for (const field of [...PROFILE_FIELDS, "recovery", "archived"] as const) {
    const winner = pickWinner(field, local, remote, base);
    if (winner === "unresolved") {
      unresolved.push(field);
      continue;
    }
    if (winner === "local") nextRemote = take(field, local, nextRemote);
    if (winner === "remote") nextLocal = take(field, remote, nextLocal);
    fields[field] = comparable(field, winner === "remote" ? remote : local);
  }

  const memories = mergeMemories(local, remote, base);
  if (!sameValue(memories, local.memories)) nextLocal = { ...nextLocal, memories };
  if (!sameValue(memories, remote.memories)) nextRemote = { ...nextRemote, memories };

  const saves: AgentSyncSave[] = [];
  if (nextLocal !== local)
    saves.push({ side: "local", record: nextLocal, expectedRevision: local.revision });
  if (nextRemote !== remote)
    saves.push({ side: "remote", record: nextRemote, expectedRevision: remote.revision });
  return {
    agentId: local.profile.id,
    name: nextLocal.profile.name,
    saves,
    nextBase: { fields, memories: Object.fromEntries(memories.map((m) => [m.id, m])) },
    unresolved,
  };
}

/**
 * One step per agent that exists on either side. Agents are never deleted, so one that is
 * missing on a side is created there, with its project and model matched to that side.
 */
export function planAgentSync(input: {
  readonly local: AgentSyncSide;
  readonly remote: AgentSyncSide;
  readonly bases: Readonly<Record<string, AgentSyncBase>>;
}): ReadonlyArray<AgentSyncStep> {
  const { local, remote, bases } = input;
  const remoteById = new Map(remote.agents.map((agent) => [agent.profile.id, agent]));
  const localIds = new Set(local.agents.map((agent) => agent.profile.id));
  const steps: AgentSyncStep[] = [];

  const create = (source: WorkspaceAgent, from: AgentSyncSide, to: AgentSyncSide) => {
    // A hidden agent the other side never had is not worth spreading.
    if (source.archivedAt) return;
    const { record } = planAgentMove({
      source,
      targetAgents: [],
      sourceProjects: from.projects,
      targetProjects: to.projects,
      targetProviders: to.providers,
    });
    if (!record) return;
    steps.push({
      agentId: source.profile.id,
      name: source.profile.name,
      saves: [{ side: to === local ? "local" : "remote", record, expectedRevision: 0 }],
      nextBase: baseOf(source),
      unresolved: [],
    });
  };

  for (const agent of local.agents) {
    const other = remoteById.get(agent.profile.id);
    if (other) steps.push(planPair(agent, other, bases[agent.profile.id]));
    else create(agent, local, remote);
  }
  for (const agent of remote.agents) {
    if (!localIds.has(agent.profile.id)) create(agent, remote, local);
  }
  return steps;
}
