import { describe, expect, it } from "vite-plus/test";

import { aggregateThreadUsage, formatThreadUsageCost } from "./threadUsage";

type Turns = Parameters<typeof aggregateThreadUsage>[0];

describe("aggregateThreadUsage", () => {
  it("sums reported turns and keeps the latest answering model", () => {
    const turns = [
      {
        answeringModel: "claude-a",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 60,
          cacheCreationTokens: 5,
          hasSubagents: false,
        },
      },
      { answeringModel: "claude-b" },
      {
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 50,
          outputTokens: 5,
          hasSubagents: true,
        },
      },
    ] as unknown as Turns;
    expect(aggregateThreadUsage(turns)).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
      cacheReadTokens: 60,
      cacheWriteTokens: 5,
      reportedTurns: 2,
      loadedTurns: 3,
      partial: false,
      excludesSubagents: true,
      lastAnsweringModel: "claude-b",
      cost: null,
    });
  });

  it("flags partial reports and skips unavailable ones", () => {
    const turns = [
      {
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "partial",
          outputTokens: 7,
          hasSubagents: false,
        },
      },
      {
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "unavailable",
          hasSubagents: false,
        },
      },
    ] as unknown as Turns;
    const totals = aggregateThreadUsage(turns);
    expect(totals).toMatchObject({ outputTokens: 7, reportedTurns: 1, partial: true });
  });

  it("returns zeros for an empty thread", () => {
    expect(aggregateThreadUsage([])).toMatchObject({ reportedTurns: 0, cost: null });
  });

  it("sums provider-reported cost in one currency and drops mixed currencies", () => {
    const thread = (amount: number, currency: string) =>
      ({ contextUsage: { usedTokens: 1, cost: { amount, currency } } }) as never;
    expect(aggregateThreadUsage([], [thread(0.5, "USD"), thread(0.25, "USD")]).cost).toEqual({
      amount: 0.75,
      currency: "USD",
    });
    expect(aggregateThreadUsage([], [thread(1, "USD"), thread(1, "EUR")]).cost).toBeNull();
    expect(aggregateThreadUsage([], [{ contextUsage: null }]).cost).toBeNull();
  });
});

describe("formatThreadUsageCost", () => {
  it("shows sub-dollar amounts with extra precision", () => {
    expect(formatThreadUsageCost({ amount: 0.1234, currency: "USD" })).toBe("$0.1234");
    expect(formatThreadUsageCost({ amount: 12.5, currency: "USD" })).toBe("$12.50");
  });
});
