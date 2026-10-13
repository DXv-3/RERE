import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  RoutingPrediction,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  primaryServerProvidersAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../../state/server";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createDebouncedRunner,
  forecastLine,
  modelLabel,
  selectionEffort,
} from "./routingForecast.logic";

/**
 * A muted line beside the Auto control saying which model Auto will start a new thread on (or
 * that an existing thread keeps its own). It watches the draft itself, so the line follows typing
 * and model changes without re-rendering the whole chat; the server is asked once typing pauses.
 */
export function RoutingForecast({
  environmentId,
  instanceId,
  cwd,
  newThread,
  draftTarget,
  getModelSelection,
  getTask,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId | null;
  cwd: string | null;
  newThread: boolean;
  draftTarget: ScopedThreadRef | DraftId;
  getModelSelection: () => ModelSelection | undefined;
  getTask: () => string;
}) {
  const settings = useAtomValue(primaryServerSettingsAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const preview = useAtomCommand(serverEnvironment.routingPreview, { reportFailure: false });
  const [predicted, setPredicted] = useState<RoutingPrediction | null>(null);
  const lastKey = useRef<string | null>(null);
  // The getters are new functions on every render; reading them through a ref keeps the
  // debounce from restarting on renders that did not change the draft.
  const getters = useRef({ getModelSelection, getTask });
  useEffect(() => {
    getters.current = { getModelSelection, getTask };
  });
  // Any edit to the draft (text or model) gives a new object, which restarts the wait.
  const draft = useComposerDraftStore((store) => store.getComposerDraft(draftTarget));
  const on = settings.routingMode === "automatic";
  const selection = getModelSelection();
  const selectionKey = JSON.stringify(selection ?? null);
  useEffect(() => {
    // Only a new thread's first message is routed; there is nothing to ask otherwise.
    if (!on || !newThread) {
      lastKey.current = null;
      return;
    }
    let live = true;
    const runner = createDebouncedRunner(() => {
      const modelSelection = getters.current.getModelSelection();
      if (!modelSelection) return;
      const task = getters.current.getTask().slice(0, 4_000);
      const key = JSON.stringify([task, modelSelection, cwd]);
      if (key === lastKey.current) return;
      lastKey.current = key;
      void preview({
        environmentId,
        input: { instanceId, cwd, task, modelSelection },
      }).then(
        (response) => {
          if (!live) return;
          if (response._tag === "Success") setPredicted(response.value.predicted ?? null);
          else lastKey.current = null;
        },
        () => {
          if (live) lastKey.current = null;
        },
      );
    });
    runner.schedule();
    // Sending clears the draft, which re-runs this effect: the wait is dropped and any answer
    // still on its way is ignored.
    return () => {
      live = false;
      runner.cancel();
    };
  }, [
    on,
    newThread,
    draftTarget,
    selectionKey,
    environmentId,
    instanceId,
    cwd,
    preview,
    getModelSelection,
    getTask,
  ]);
  const line = forecastLine({
    mode: settings.routingMode,
    newThread,
    predicted,
    current: selection
      ? { name: modelLabel(providers, selection), effort: selectionEffort(selection) }
      : null,
  });
  if (!line) return null;
  return (
    <span data-wb-routing-forecast="" role="status" aria-live="polite">
      {line}
    </span>
  );
}
