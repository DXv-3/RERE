import { useConnectedEnvironmentIds } from "../../state/environments";
import { useCallback, useEffect, useState, useRef, useEffectEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkspaceAgent,
  AgentImportInput,
  AgentContinuation,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { threadEnvironment } from "../../state/threads";
import { useServerConfigs } from "../../state/entities";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readAgentArchive } from "./grokBotImport";
import { useWorkbenchPreferences, type AgentProfile } from "./workbenchPreferences";

// Views outside this hook (the conversation header) reload their agent copy on this event.
export const AGENTS_CHANGED_EVENT = "workbench:agents-changed";

/** The copy of an agent with the higher revision: `incoming` unless `current` already holds a newer one. */
function newerOf(incoming: WorkspaceAgent, current: readonly WorkspaceAgent[]): WorkspaceAgent {
  const held = current.find((a) => a.profile.id === incoming.profile.id);
  return held && held.revision > incoming.revision ? held : incoming;
}

/**
 * Agents are stored per environment, so everything here works against the environment the
 * caller picks. Importing the old browser-local agents stays tied to the primary one.
 */
export function useAgentWorkspace(environmentId: EnvironmentId | null) {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const isPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const connectedIds = useConnectedEnvironmentIds();
  const connected = environmentId !== null && connectedIds.includes(environmentId);
  const serverConfigs = useServerConfigs();
  const config = environmentId ? serverConfigs.get(environmentId) : undefined;
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  const updateThread = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const saveCommand = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const importCommand = useAtomCommand(serverEnvironment.agentsImport, { reportFailure: false });
  const prepareCommand = useAtomCommand(serverEnvironment.agentsPrepare, { reportFailure: false });
  const activeEnvironment = useRef(environmentId);
  // Which environment `entries` came from: revisions are per environment and never comparable across two.
  const entriesEnvironment = useRef<typeof environmentId>(null);
  const [loadedEnvironment, setLoadedEnvironment] = useState<typeof environmentId>(null);
  const [entries, setEntries] = useState<readonly WorkspaceAgent[]>([]);
  const [errorState, setErrorState] = useState<{
    environmentId: typeof environmentId;
    message: string;
  }>({
    environmentId,
    message: "",
  });
  const setError = useCallback(
    (message: string) => setErrorState({ environmentId, message }),
    [environmentId],
  );
  // A failure belongs to the environment that produced it, not whichever is selected next.
  const error = errorState.environmentId === environmentId ? errorState.message : "";
  const [ready, setReady] = useState(false);
  const refresh = useCallback(async () => {
    if (!environmentId || !connected) return;
    const result = await list({ environmentId, input: {} });
    if (activeEnvironment.current !== environmentId) return;
    if (result._tag === "Failure") {
      setError("Agent storage is unavailable. Your local profiles and archives are preserved.");
      setReady(false);
      return;
    }
    setLoadedEnvironment(environmentId);
    // A list that was in flight while a goal call saved the agent can predate that save.
    const sameEnvironment = entriesEnvironment.current === environmentId;
    entriesEnvironment.current = environmentId;
    setEntries((current) =>
      sameEnvironment ? result.value.map((agent) => newerOf(agent, current)) : result.value,
    );
    setReady(true);
    setError("");
  }, [environmentId, list, connected, setError]);
  useEffect(() => {
    activeEnvironment.current = environmentId;
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
      activeEnvironment.current = null;
    };
  }, [refresh, environmentId]);
  const save = async (agent: WorkspaceAgent) => {
    if (!environmentId || loadedEnvironment !== environmentId || !ready)
      throw new Error("Connect to your Workbench environment first.");
    const result = await saveCommand({
      environmentId,
      input: { agent, expectedRevision: agent.revision },
    });
    if (result._tag === "Failure")
      throw new Error(
        "Could not save this agent. Refresh to check for changes from another device.",
      );
    if (activeEnvironment.current !== environmentId) return result.value;
    setEntries((current) =>
      current.some((a) => a.profile.id === agent.profile.id)
        ? current.map((a) => (a.profile.id === agent.profile.id ? result.value : a))
        : [...current, result.value],
    );
    window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
    return result.value;
  };
  /**
   * Takes an agent record the server just returned from a call other than `save` (a goal call
   * bumps the revision). Without it the next ordinary save would send a stale revision.
   */
  const applyAgent = (agent: WorkspaceAgent, forEnvironmentId: EnvironmentId) => {
    if (activeEnvironment.current !== forEnvironmentId) return;
    setEntries((current) =>
      current.some((a) => a.profile.id === agent.profile.id)
        ? current.map((a) => (a.profile.id === agent.profile.id ? newerOf(agent, [a]) : a))
        : [...current, agent],
    );
    window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
  };
  const importAgents = async (input: typeof AgentImportInput.Type) => {
    if (!environmentId) throw new Error("Connect to your Workbench environment first.");
    const result = await importCommand({ environmentId, input });
    if (result._tag === "Failure")
      throw new Error("The import could not be saved. Your original export is unchanged.");
    await refresh();
    window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
    return result.value;
  };
  const migrateLocal = async () => {
    if (!isPrimary)
      throw new Error("Existing agents can only be brought into this device's own workspace.");
    const owner = localStorage.getItem("workbench:profiles:server-owner");
    if (owner && owner !== environmentId) return;
    const local = useWorkbenchPreferences.getState();
    // Keep the original device copy before replacing any view with server-owned data.
    if (!localStorage.getItem("workbench:profiles:before-server"))
      localStorage.setItem(
        "workbench:profiles:before-server",
        JSON.stringify({ agents: local.agents, assignments: local.assignments }),
      );
    const agents = await Promise.all(
      local.agents.map(async (profile) => ({
        profile,
        archive: profile.id.startsWith("grok-bot:")
          ? ((await readAgentArchive(profile.id)) ?? null)
          : null,
        threadIds: Object.entries(local.assignments).flatMap(([key, agentId]) => {
          try {
            const [env, id] = JSON.parse(key);
            return agentId === profile.id && env === environmentId && typeof id === "string"
              ? [id]
              : [];
          } catch {
            return [];
          }
        }),
      })),
    );
    const payload = JSON.stringify(agents);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const key = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    // Claim this device copy before the request so switching environments cannot copy it elsewhere after an uncertain response.
    localStorage.setItem("workbench:profiles:server-owner", environmentId ?? "");
    const receipt = await importAgents({ receiptId: `device-${key}`, agents });
    localStorage.setItem(`workbench:migration:${environmentId}`, JSON.stringify(receipt));
    return receipt;
  };
  const migrateFromEffect = useEffectEvent(() => {
    void migrateLocal().catch((e) =>
      setError(e instanceof Error ? e.message : "Could not migrate local agents."),
    );
  });
  const attemptedMigration = useRef<string | null>(null);
  useEffect(() => {
    if (
      !isPrimary ||
      !ready ||
      loadedEnvironment !== environmentId ||
      !environmentId ||
      attemptedMigration.current === environmentId
    )
      return;
    const locals = useWorkbenchPreferences.getState().agents;
    if (!locals.some((a) => !entries.some((e) => e.profile.id === a.id))) return;
    attemptedMigration.current = environmentId;
    migrateFromEffect();
  }, [isPrimary, ready, loadedEnvironment, environmentId, entries]);
  const saveProfile = async (profile: AgentProfile) => {
    const previous = entries.find((a) => a.profile.id === profile.id);
    const saved = await save(
      previous
        ? { ...previous, profile }
        : {
            profile,
            revision: 0,
            archive: null,
            recovery: {
              disposition: "ready",
              summary: "New Workbench agent.",
              blockers: [],
              verifiedAt: null,
              evidence: [],
            },
            memories: [],
            primaryThreadId: null,
            updatedAt: new Date().toISOString(),
          },
    );
    const effectiveModel = profile.modelSelection ?? config?.settings.defaultModelSelection;
    if (
      previous?.primaryThreadId &&
      environmentId &&
      effectiveModel &&
      JSON.stringify(previous.profile.modelSelection) !== JSON.stringify(profile.modelSelection)
    ) {
      const result = await updateThread({
        environmentId,
        input: {
          threadId: ThreadId.make(previous.primaryThreadId),
          modelSelection: effectiveModel,
        },
      });
      if (result._tag === "Failure")
        throw new Error(
          "Profile saved, but the conversation model could not be changed. Select it in the conversation before sending.",
        );
    }
    return saved;
  };
  const prepare = async (id: string): Promise<AgentContinuation> => {
    if (!environmentId) throw new Error("Connect to your environment first.");
    const result = await prepareCommand({ environmentId, input: { id, maxCharacters: 24000 } });
    if (result._tag === "Failure") throw new Error("Could not prepare the continuation.");
    return result.value;
  };
  return {
    environmentId,
    isPrimary,
    connected,
    entries: loadedEnvironment === environmentId ? entries : [],
    ready: ready && loadedEnvironment === environmentId,
    error,
    refresh,
    save,
    applyAgent,
    saveProfile,
    importAgents,
    migrateLocal,
    prepare,
  };
}
