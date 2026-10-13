import type { RoutingSavings } from "@t3tools/contracts";
import type { ModelRate } from "../usage/usagePricing.ts";
import type { MovedThread } from "./RoutingDecisionStore.ts";

/** What the tokens a thread ran would cost on a model, in millionths of a dollar. */
const cost = (move: MovedThread, rate: ModelRate) =>
  (Math.max(0, move.inputTokens - move.cachedInputTokens) * rate.inputCostPerToken +
    move.cachedInputTokens * rate.cacheReadCostPerToken +
    move.outputTokens * rate.outputCostPerToken) *
  1_000_000;

/**
 * Adds up what Auto's standing picks were worth: the same tokens priced on the model the thread
 * arrived on and on the one Auto picked. A cheaper pick is a saving, a dearer one a cost, and a
 * move with an unpriced model is counted apart rather than guessed at.
 */
export function summarizeSavings(
  moves: ReadonlyArray<MovedThread>,
  jevMicroUsd: number,
  rateOf: (model: string) => ModelRate | null,
): RoutingSavings {
  const lighter = { threads: 0, tokens: 0, microUsd: 0 };
  const stronger = { threads: 0, tokens: 0, microUsd: 0 };
  let unpricedThreads = 0;
  for (const move of moves) {
    const from = rateOf(move.fromModel);
    const to = rateOf(move.toModel);
    if (!from || !to) {
      unpricedThreads++;
      continue;
    }
    // Which way a move went is read from the prices themselves, so an unused thread still counts.
    const cheaper =
      to.inputCostPerToken + to.outputCostPerToken <
      from.inputCostPerToken + from.outputCostPerToken;
    const side = cheaper ? lighter : stronger;
    side.threads++;
    side.tokens += move.inputTokens + move.outputTokens;
    side.microUsd += Math.abs(cost(move, from) - cost(move, to));
  }
  lighter.microUsd = Math.round(lighter.microUsd);
  stronger.microUsd = Math.round(stronger.microUsd);
  return {
    lighter,
    stronger,
    unpricedThreads,
    jevMicroUsd,
    since: moves[0]?.decidedAt ?? null,
  };
}
