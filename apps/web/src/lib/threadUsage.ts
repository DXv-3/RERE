import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

export interface ThreadUsageCost {
  readonly amount: number;
  readonly currency: string;
}

export interface ThreadUsageTotals {
  /** Input includes cache reads and writes, as providers report it. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Turns that carried a usage report, out of all loaded turns. */
  readonly reportedTurns: number;
  readonly loadedTurns: number;
  /** True when a counted turn only had a partial report, so totals are lower bounds. */
  readonly partial: boolean;
  /** Main-agent usage only; true when any counted turn also ran subagents. */
  readonly excludesSubagents: boolean;
  /** The model the provider says answered most recently, when it reports one. */
  readonly lastAnsweringModel: string | null;
  /** Provider-reported spend, summed over provider threads that reported one in one currency. */
  readonly cost: ThreadUsageCost | null;
}

type TurnUsageInput = Pick<OrchestrationV2ProviderTurn, "turnTokenUsage" | "answeringModel">;
type ProviderThreadCostInput = Pick<OrchestrationV2ProviderThread, "contextUsage">;

/**
 * Sums the per-turn usage reports of the turns loaded in the thread projection.
 * Cost is only what providers reported themselves; there is no client rate table,
 * so an unreported cost stays null rather than being guessed.
 */
export function aggregateThreadUsage(
  turns: ReadonlyArray<TurnUsageInput>,
  providerThreads: ReadonlyArray<ProviderThreadCostInput> = [],
): ThreadUsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reportedTurns = 0;
  let partial = false;
  let excludesSubagents = false;
  let lastAnsweringModel: string | null = null;
  for (const turn of turns) {
    if (turn.answeringModel) lastAnsweringModel = turn.answeringModel;
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable") continue;
    reportedTurns += 1;
    if (usage.usageStatus === "partial") partial = true;
    if (usage.hasSubagents) excludesSubagents = true;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cachedInputTokens ?? 0;
    cacheWriteTokens += usage.cacheCreationTokens ?? 0;
  }
  let cost: ThreadUsageCost | null = null;
  let mixedCurrency = false;
  for (const providerThread of providerThreads) {
    const reported = providerThread.contextUsage?.cost;
    if (!reported) continue;
    if (cost === null) cost = { amount: reported.amount, currency: reported.currency };
    else if (cost.currency === reported.currency) {
      cost = { amount: cost.amount + reported.amount, currency: cost.currency };
    } else mixedCurrency = true;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reportedTurns,
    loadedTurns: turns.length,
    partial,
    excludesSubagents,
    lastAnsweringModel,
    cost: mixedCurrency ? null : cost,
  };
}

export function formatThreadUsageCost(cost: ThreadUsageCost): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cost.currency,
      maximumFractionDigits: cost.amount < 1 ? 4 : 2,
    }).format(cost.amount);
  } catch {
    return `${cost.amount.toFixed(cost.amount < 1 ? 4 : 2)} ${cost.currency}`;
  }
}
