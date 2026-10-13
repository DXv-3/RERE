import type {
  JevAdvice,
  ModelSelection,
  RoutingLadder,
  RoutingPrediction,
  RoutingPreference,
  ServerProvider,
} from "@t3tools/contracts";
import {
  adjustAdvice,
  chooseSelection,
  effortOf,
  localAdvice,
  mergeAdvice,
  type PriceOf,
  resolveLadder,
  weeklyPace,
} from "./automaticSelection.ts";
import { BLOCKED, previewRouting } from "./routingPolicy.ts";

/**
 * The model and effort Auto would give the first message of a new thread, using the same
 * functions the send path uses. It never asks Jev for anything: a Jev judgment counts only when
 * the caller already holds one for this text. Without it the answer is the local rules' view,
 * which Jev may refine when the message is actually sent.
 */
export function predictSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly task: string;
  readonly preference: RoutingPreference;
  readonly pacing: boolean;
  readonly ladders: Readonly<Record<string, RoutingLadder | undefined>>;
  readonly recoveredJev: JevAdvice | null;
  readonly priceOf?: PriceOf;
  readonly now: number;
}): RoutingPrediction | null {
  const { providers, ladders, now } = input;
  const task = input.task.slice(0, 4_000);
  let current = input.current;
  // A blocked account hands the thread to the best available one, as the send does.
  const status = previewRouting(
    providers,
    { instanceId: current.instanceId, task: "", cwd: null },
    now,
  );
  const account = status.accounts.find((item) => item.instanceId === current.instanceId);
  const target = providers.find((item) => item.instanceId === status.recommendedInstanceId);
  const fallbackModel =
    target &&
    (resolveLadder(target, ladders[target.instanceId], input.priceOf).standard ??
      target.models.find((item) => item.isDefault)?.slug ??
      target.models[0]?.slug);
  if (account && BLOCKED.has(account.reason) && target && fallbackModel)
    current = { instanceId: target.instanceId, model: fallbackModel };
  const provider = providers.find((item) => item.instanceId === current.instanceId);
  if (!provider) return null;
  const jev = input.recoveredJev;
  const advice = jev ? mergeAdvice(jev) : localAdvice(task, 0);
  const adjusted = adjustAdvice(
    advice,
    input.preference,
    input.pacing ? weeklyPace(provider, now) : null,

    task,
  );
  const { selection } = chooseSelection({
    provider,
    current,
    advice: adjusted.advice,
    ladder: resolveLadder(provider, ladders[provider.instanceId], input.priceOf),
    ...(input.priceOf ? { priceOf: input.priceOf } : {}),
  });
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    modelName:
      provider.models.find((item) => item.slug === selection.model)?.name ?? selection.model,
    effort: effortOf(selection, provider),
    basis: jev ? "jev" : "local",
  };
}
