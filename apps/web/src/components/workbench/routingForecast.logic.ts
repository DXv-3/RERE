import type {
  ModelSelection,
  RoutingMode,
  RoutingPrediction,
  ServerProvider,
} from "@t3tools/contracts";

/** Typing has to pause this long before the forecast asks the server again. */
export const FORECAST_DEBOUNCE_MS = 600;

const EFFORT_OPTION_IDS = ["effort", "reasoningEffort"];

/** The effort set on a selection, when it sets one. */
export function selectionEffort(selection: ModelSelection): string | null {
  const value = selection.options?.find((option) => EFFORT_OPTION_IDS.includes(option.id))?.value;
  return typeof value === "string" ? value : null;
}

/** A model's display name, falling back to its id when the account does not list it. */
export function modelLabel(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  const provider = providers.find((item) => item.instanceId === selection.instanceId);
  return provider?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
}

const withEffort = (name: string, effort: string | null) =>
  effort ? `${name} · ${effort} effort` : name;

/**
 * The quiet line next to the Auto control. It speaks only when Auto is about to change something:
 * a new thread whose first message will run on a different model or effort than the one showing
 * in the picker. An existing thread keeps its model, and the picker already shows it. Built-in
 * rules alone are a guess Jev may refine at send time, so they read "likely".
 */
export function forecastLine(input: {
  mode: RoutingMode;
  newThread: boolean;
  predicted: RoutingPrediction | null;
  current: { name: string; effort: string | null } | null;
}): string | null {
  if (input.mode !== "automatic" || !input.newThread || !input.predicted) return null;
  const { predicted, current } = input;
  const sameEffort = !current?.effort || !predicted.effort || current.effort === predicted.effort;
  if (current && current.name === predicted.modelName && sameEffort) return null;
  const pick = withEffort(predicted.modelName, predicted.effort);
  return predicted.basis === "jev" ? `Auto will pick: ${pick}` : `Auto will likely pick: ${pick}`;
}

/** Runs `run` once typing has paused for `delayMs`; every `schedule` restarts the wait. */
export function createDebouncedRunner(run: () => void, delayMs = FORECAST_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel,
  };
}
