import { useAtomValue } from "@effect/atom-react";
import {
  createAgentOwnedThreadsAtom,
  withoutAgentOwnedThreads,
} from "@t3tools/client-runtime/state/agent-owned-threads";
import { createEnvironmentSummaryAtoms } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const { connectedEnvironmentIdsAtom } = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

/** Threads the server says belong to an agent, per connected environment; empty until loaded. */
const agentOwnedThreadsAtom = createAgentOwnedThreadsAtom({
  agentList: serverEnvironment.agentList,
  environmentIdsAtom: connectedEnvironmentIdsAtom,
});

/**
 * The Threads list: agent conversations live in Agents and are opened from
 * there. Fails open, so a list that has not loaded hides nothing.
 */
const sessionNavigationThreadShellsAtom = Atom.make((get) =>
  withoutAgentOwnedThreads(
    get(environmentThreadShells.navigationThreadShellsAtom),
    get(agentOwnedThreadsAtom),
  ),
).pipe(Atom.withLabel("mobile-session-navigation-thread-shells"));

export function useSessionNavigationThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(sessionNavigationThreadShellsAtom);
}

/** Mount once on the home list: re-reads the agent lists whenever the app returns to the foreground. */
export function useRefreshAgentOwnedThreadsOnForeground() {
  const environmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      for (const environmentId of environmentIds) {
        appAtomRegistry.refresh(serverEnvironment.agentList({ environmentId, input: {} }));
      }
    });
    return () => subscription.remove();
  }, [environmentIds]);
}
