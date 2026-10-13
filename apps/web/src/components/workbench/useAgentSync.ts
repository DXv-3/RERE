import {
  baseKeeping,
  planAgentSync,
  type AgentSyncBase,
  type AgentSyncField,
} from "@t3tools/client-runtime/operations/agent-sync";
import {
  syncAgentConversation,
  type ConversationCopyState,
  liveConversationsFromStored,
  findConversationCopy,
  type ConversationSide,
} from "@t3tools/client-runtime/operations/agent-conversation-sync";
import { pickTransferModel } from "@t3tools/client-runtime/operations/thread-transfer";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ThreadId, type EnvironmentId, type WorkspaceAgent } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENTS_CHANGED_EVENT } from "./useAgentWorkspace";
import { useWorkbenchPreferences } from "./workbenchPreferences";

// Each pass reads both full agent lists, so the timer is slow; edits and focus sync at once.
const SYNC_INTERVAL_MS = 120_000;

export interface AgentSyncStatus {
  readonly state: "idle" | "syncing" | "synced" | "error";
  readonly syncedAt: string | null;
  /** Agents whose copies differ with no history to say which is newer. Nothing was overwritten. */
  readonly unresolved: ReadonlyArray<{
    readonly agentId: string;
    readonly name: string;
    readonly fields: ReadonlyArray<AgentSyncField>;
  }>;
  /** Agents a side refused to save this pass; they are retried on the next one. */
  readonly failed: ReadonlyArray<string>;
  /** Where each agent's live conversation is, so opening an agent lands on it. */
  readonly live: Readonly<
    Record<string, { readonly environmentId: EnvironmentId; readonly threadId: string }>
  >;
  /** Agents whose conversation could not be copied across this pass. */
  readonly conversationsFailed: ReadonlyArray<string>;
  /** Which thread is the live one and which the copy, per agent, with the environments they sit in. */
  readonly pairing: {
    readonly local: EnvironmentId;
    readonly remote: EnvironmentId;
    readonly copies: Readonly<Record<string, ConversationCopyState>>;
  } | null;
}

const IDLE: AgentSyncStatus = {
  state: "idle",
  syncedAt: null,
  unresolved: [],
  failed: [],
  live: {},
  conversationsFailed: [],
  pairing: null,
};
let status = IDLE;
const listeners = new Set<() => void>();
function setStatus(next: AgentSyncStatus) {
  status = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The latest background sync result, for the Agents tab. */
export function useAgentSyncStatus(): AgentSyncStatus {
  return useSyncExternalStore(subscribe, () => status);
}

/**
 * When the open thread is the copy side of an agent's conversation: where the live one is and
 * whether that environment is connected right now. Null for every other thread, and while sync
 * has not learned the pairing yet.
 */
export function useConversationCopy(
  environmentId: EnvironmentId | null | undefined,
  threadId: string | null | undefined,
): {
  readonly agentId: string;
  readonly live: { readonly environmentId: EnvironmentId; readonly threadId: string };
  readonly liveLabel: string;
  readonly liveReachable: boolean;
} | null {
  const { pairing } = useAgentSyncStatus();
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  if (!pairing || !environmentId || !threadId) return null;
  const found = findConversationCopy(
    pairing.copies,
    (which) => (which === "local" ? pairing.local : pairing.remote),
    { environmentId, threadId },
  );
  if (!found) return null;
  return {
    ...found,
    liveLabel:
      environments.find((e) => e.environmentId === found.live.environmentId)?.label ??
      "another machine",
    liveReachable: connectedIds.includes(found.live.environmentId),
  };
}

/**
 * The environment agents are kept in sync with, or null. "auto" picks the only other saved
 * environment and nothing when there are several, so agents never spread to a second remote
 * the user did not choose.
 */
export function useAgentSyncTarget(): EnvironmentId | null {
  const preference = useWorkbenchPreferences((state) => state.agentSyncTarget);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const others = environments.filter((e) => e.environmentId !== primaryEnvironmentId);
  if (primaryEnvironmentId === null || preference === "off") return null;
  if (preference === "auto") return others.length === 1 ? others[0]!.environmentId : null;
  return others.find((e) => e.environmentId === preference)?.environmentId ?? null;
}

// What the last pass read, so a choice between differing copies can be recorded without a reload.
let lastRead: {
  readonly basesKey: string;
  readonly local: ReadonlyArray<WorkspaceAgent>;
  readonly remote: ReadonlyArray<WorkspaceAgent>;
} | null = null;

/** Keeps one side's copy of the fields that differ and starts a pass that copies it across. */
export function keepAgentSyncSide(agentId: string, keep: "local" | "remote") {
  const entry = status.unresolved.find((item) => item.agentId === agentId);
  const loser = (keep === "local" ? lastRead?.remote : lastRead?.local)?.find(
    (agent) => agent.profile.id === agentId,
  );
  if (!entry || !loser || !lastRead) return;
  const bases = readBases(lastRead.basesKey);
  bases[agentId] = baseKeeping(bases[agentId], loser, entry.fields);
  try {
    localStorage.setItem(lastRead.basesKey, JSON.stringify(bases));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
}

function readStored<Value>(key: string): Record<string, Value> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Value>) : {};
  } catch {
    return {};
  }
}
const readBases = (key: string) => readStored<AgentSyncBase>(key);

function parseProjectKey(key: string): readonly [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/**
 * Mount once. Keeps agents equal between this device's environment and the sync target in the
 * background. Saves carry the revision they read, so a concurrent edit fails that one save and
 * the next pass merges it.
 */
export function useAgentSync() {
  const localId = usePrimaryEnvironmentId();
  const remoteId = useAgentSyncTarget();
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const configs = useServerConfigs();
  const projects = useProjects();
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const exportThread = useAtomCommand(serverEnvironment.exportThreadTransfer, {
    reportFailure: false,
  });
  const importThread = useAtomCommand(serverEnvironment.importThreadTransfer, {
    reportFailure: false,
  });
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const online = (id: EnvironmentId | null) =>
    id !== null && connectedIds.includes(id) && configs.has(id);
  const ready = online(localId) && online(remoteId);
  // A different pair starts over at once instead of waiting for the timer.
  const pair = ready ? `${localId}:${remoteId}` : null;
  const running = useRef(false);
  const again = useRef(false);
  const announcing = useRef(false);

  // Before the first pass of a session, and while the other environment is unreachable, the last
  // known live side still decides where an agent's conversation opens.
  useEffect(() => {
    if (localId === null || remoteId === null) return;
    if (Object.keys(status.live).length > 0) return;
    const storedCopies = readStored<ConversationCopyState>(
      `workbench:agent-conversations:${localId}:${remoteId}`,
    );
    const stored = liveConversationsFromStored(storedCopies, (which) =>
      which === "local" ? localId : remoteId,
    );
    if (Object.keys(stored).length > 0) {
      setStatus({
        ...status,
        live: stored,
        pairing: { local: localId, remote: remoteId, copies: storedCopies },
      });
    }
  }, [localId, remoteId]);

  const pass = useEffectEvent(async () => {
    if (!ready || localId === null || remoteId === null) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setStatus({ ...status, state: "syncing" });
    try {
      const [localList, remoteList] = await Promise.all([
        list({ environmentId: localId, input: {} }),
        list({ environmentId: remoteId, input: {} }),
      ]);
      if (localList._tag === "Failure" || remoteList._tag === "Failure") {
        setStatus({ ...status, state: "error" });
        return;
      }
      const side = (environmentId: EnvironmentId, agents: typeof localList.value) => ({
        agents,
        projects: projects.filter((p) => p.environmentId === environmentId),
        providers: configs.get(environmentId)?.providers ?? [],
      });
      const basesKey = `workbench:agent-sync:${localId}:${remoteId}`;
      const bases = readBases(basesKey);
      lastRead = { basesKey, local: localList.value, remote: remoteList.value };
      const steps = planAgentSync({
        local: side(localId, localList.value),
        remote: side(remoteId, remoteList.value),
        bases,
      });
      const failed: string[] = [];
      let saved = false;
      const environmentOf = (which: ConversationSide) => (which === "local" ? localId : remoteId);
      // The records as they stand after this pass's saves, for the conversation step below.
      const current = {
        local: new Map(localList.value.map((agent) => [agent.profile.id, agent])),
        remote: new Map(remoteList.value.map((agent) => [agent.profile.id, agent])),
      };
      for (const step of steps) {
        let ok = true;
        for (const item of step.saves) {
          const result = await save({
            environmentId: environmentOf(item.side),
            input: { agent: item.record, expectedRevision: item.expectedRevision },
          });
          if (result._tag === "Failure") ok = false;
          else {
            saved = true;
            current[item.side].set(step.agentId, result.value);
          }
        }
        if (ok) bases[step.agentId] = step.nextBase;
        else failed.push(step.name);
      }
      try {
        localStorage.setItem(basesKey, JSON.stringify(bases));
      } catch {
        // Without stored bases the next pass treats both sides as never synced, which only
        // leaves differing fields alone.
      }

      const copiesKey = `workbench:agent-conversations:${localId}:${remoteId}`;
      const copies = readStored<ConversationCopyState>(copiesKey);
      const live: Record<string, { environmentId: EnvironmentId; threadId: string }> = {};
      const conversationsFailed: string[] = [];
      for (const [agentId, local] of current.local) {
        const remote = current.remote.get(agentId);
        if (!remote || local.archivedAt || remote.archivedAt) continue;
        if (!local.primaryThreadId && !remote.primaryThreadId) continue;
        const agents = { local, remote };
        const result = await syncAgentConversation({
          agents,
          state: copies[agentId] ?? null,
          ports: {
            exportThread: async (which, input) => {
              const exported = await exportThread({
                environmentId: environmentOf(which),
                input: { ...input, threadId: ThreadId.make(input.threadId) },
              });
              if (exported._tag === "Success") return exported.value;
              const error = squashAtomCommandFailure(exported);
              return typeof error === "object" &&
                error !== null &&
                (error as { reason?: unknown }).reason === "run_in_progress"
                ? "busy"
                : null;
            },
            importThread: async (which, input) => {
              const imported = await importThread({ environmentId: environmentOf(which), input });
              return imported._tag === "Success" ? imported.value : null;
            },
            resolveTarget: async (which, agent, exported) => {
              const environmentId = environmentOf(which);
              const parsed = parseProjectKey(agent.profile.projectKey);
              const project = parsed
                ? projects.find((p) => p.environmentId === environmentId && p.id === parsed[1])
                : undefined;
              const providers = configs.get(environmentId)?.providers ?? [];
              const model = pickTransferModel({
                source: agent.profile.modelSelection ?? exported.modelSelection,
                targetProviders: providers,
                targetProjectDefault: project?.defaultModelSelection ?? null,
              }).selection;
              if (model === null) return null;
              if (project) return { projectId: project.id, modelSelection: model };
              const scratch = await ensureScratch({ environmentId, input: {} });
              return scratch._tag === "Success"
                ? { projectId: scratch.value.projectId, modelSelection: model }
                : null;
            },
            attach: async (which, agent, threadId) => {
              const attached = await save({
                environmentId: environmentOf(which),
                input: {
                  agent: {
                    ...agent,
                    primaryThreadId: threadId,
                    threadIds: [...new Set([...(agent.threadIds ?? []), threadId])],
                  },
                  expectedRevision: agent.revision,
                },
              });
              if (attached._tag === "Failure") return false;
              current[which].set(agentId, attached.value);
              saved = true;
              return true;
            },
            label: (which) =>
              environments.find((e) => e.environmentId === environmentOf(which))?.label ??
              "another environment",
            newTransferId: () => randomUUID(),
          },
        });
        if (result.state) copies[agentId] = result.state;
        if (result.outcome === "failed") conversationsFailed.push(local.profile.name);
        if (result.liveSide) {
          const threadId = current[result.liveSide].get(agentId)?.primaryThreadId;
          if (threadId) live[agentId] = { environmentId: environmentOf(result.liveSide), threadId };
        }
      }
      try {
        localStorage.setItem(copiesKey, JSON.stringify(copies));
      } catch {
        // A lost record only means the next pass makes a new copy instead of extending one.
      }
      setStatus({
        live,
        conversationsFailed,
        pairing: { local: localId, remote: remoteId, copies },
        state: "synced",
        syncedAt: new Date().toISOString(),
        unresolved: steps
          .filter((step) => step.unresolved.length > 0)
          .map((step) => ({ agentId: step.agentId, name: step.name, fields: step.unresolved })),
        failed,
      });
      if (saved) {
        announcing.current = true;
        window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
        announcing.current = false;
      }
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        void pass();
      }
    }
  });

  useEffect(() => {
    if (pair === null) return;
    void pass();
    const onChanged = () => {
      if (!announcing.current) void pass();
    };
    const onFocus = () => void pass();
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged);
    window.addEventListener("focus", onFocus);
    // Runs while the window is hidden too: a turn that finishes after the user walks away is
    // exactly the one another device needs.
    const timer = window.setInterval(() => void pass(), SYNC_INTERVAL_MS);
    return () => {
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [pair]);
}
