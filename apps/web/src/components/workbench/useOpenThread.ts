import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { isAgentOwnedThread } from "@t3tools/client-runtime/state/agent-owned-threads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useAgentOwnedThreads } from "../../state/agentOwnedThreads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useWorkbenchStore } from "./workbenchStore";

/**
 * Opens a thread on its own tab: an agent's conversation under the Agents tab, any other thread
 * under Threads. With `file`, the thread opens with that file from its folder in the right panel.
 */
export function useOpenThread(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const owned = useAgentOwnedThreads();
  const setMode = useWorkbenchStore((state) => state.setMode);
  const setAgentView = useWorkbenchStore((state) => state.setAgentView);
  return useCallback(
    (threadId: string, options?: { readonly file?: string }) => {
      const ref = scopeThreadRef(environmentId, ThreadId.make(threadId));
      if (options?.file !== undefined) useRightPanelStore.getState().openFile(ref, options.file);
      if (isAgentOwnedThread(owned, environmentId, threadId)) {
        setAgentView("conversation");
        setMode("agent");
      } else setMode("thread");
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [environmentId, navigate, owned, setAgentView, setMode],
  );
}
