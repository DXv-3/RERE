import { useEffect, useState } from "react";
import type { EnvironmentId, WorkspaceAgent } from "@t3tools/contracts";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENTS_CHANGED_EVENT } from "./useAgentWorkspace";

/**
 * The agent whose conversation this thread is (primary or additional), kept fresh. Null while it
 * loads and for an ordinary thread. Settings saves and imports happen in another view, so it
 * reloads on those and on window focus.
 */
export function useThreadAgent(
  environmentId: EnvironmentId,
  threadId: string,
): WorkspaceAgent | null {
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  // Keep the whole list, not just this thread's agent: moving between one agent's conversations
  // then finds the agent at once instead of blanking until the next load.
  const [loaded, setLoaded] = useState<{
    environmentId: EnvironmentId;
    agents: ReadonlyArray<WorkspaceAgent>;
  } | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const load = () =>
      void list({ environmentId, input: {} }).then((result) => {
        if (live && result._tag === "Success") setLoaded({ environmentId, agents: result.value });
      });
    load();
    window.addEventListener(AGENTS_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener(AGENTS_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, [environmentId, list, connected]);
  return loaded?.environmentId === environmentId
    ? (loaded.agents.find(
        (a) => a.primaryThreadId === threadId || a.threadIds?.includes(threadId),
      ) ?? null)
    : null;
}
