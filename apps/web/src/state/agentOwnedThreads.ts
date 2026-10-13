import { useAtomValue } from "@effect/atom-react";
import { createAgentOwnedThreadsAtom } from "@t3tools/client-runtime/state/agent-owned-threads";
import { useEffect } from "react";

import { AGENTS_CHANGED_EVENT } from "../components/workbench/useAgentWorkspace";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

const agentOwnedThreadsAtom = createAgentOwnedThreadsAtom({
  agentList: serverEnvironment.agentList,
  environmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
});

/**
 * Threads the server says belong to an agent, per connected environment.
 * Empty until an environment's agent list loads, so callers fail open.
 * Subscribing keeps one shared agent-list query per environment alive.
 */
export function useAgentOwnedThreads() {
  return useAtomValue(agentOwnedThreadsAtom);
}

/** Mount once: re-reads the agent lists on focus and after the Agents workspace saves. */
export function useRefreshAgentOwnedThreads() {
  const environmentIds = useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
  useEffect(() => {
    const refresh = () => {
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(serverEnvironment.agentList({ environmentId, input: {} }));
      }
    };
    window.addEventListener(AGENTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(AGENTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [environmentIds]);
}
