import { useAtomValue } from "@effect/atom-react";
import { threadIsBusyForTransfer } from "@t3tools/client-runtime/operations/thread-transfer";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import {
  resolveContinueOnAvailability,
  type ContinueOnAvailability,
  type ContinueOnEnvironmentFacts,
} from "../components/chat/continueOn.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, useThreadShell } from "./entities";
import { environmentPresentations } from "./presentation";

function environmentFacts(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): ReadonlyArray<ContinueOnEnvironmentFacts> {
  return [...presentations.entries()].map(([environmentId, presentation]) => ({
    environmentId,
    connected: presentation.connection.phase === "connected",
    serverConfig: presentation.serverConfig,
  }));
}

/** For menus that read state at open time instead of subscribing. */
export function readContinueOnAvailability(threadRef: ScopedThreadRef): ContinueOnAvailability {
  const thread = readThreadShell(threadRef);
  if (thread === null) return { kind: "hidden" };
  return resolveContinueOnAvailability({
    sourceEnvironmentId: threadRef.environmentId,
    environments: environmentFacts(appAtomRegistry.get(environmentPresentations.presentationsAtom)),
    isBusy: threadIsBusyForTransfer(thread.runtime),
  });
}

export function useContinueOnAvailability(
  threadRef: ScopedThreadRef | null,
): ContinueOnAvailability {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const thread = useThreadShell(threadRef);
  if (threadRef === null || thread === null) return { kind: "hidden" };
  return resolveContinueOnAvailability({
    sourceEnvironmentId: threadRef.environmentId,
    environments: environmentFacts(presentations),
    isBusy: threadIsBusyForTransfer(thread.runtime),
  });
}
