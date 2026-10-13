import { describe, expect, it } from "vite-plus/test";
import type { ModelRate } from "../usage/usagePricing.ts";
import { summarizeSavings } from "./routingSavings.ts";

// Dollars per million tokens: input, output, cache read.
const rate = (input: number, output: number, cacheRead: number): ModelRate => ({
  inputCostPerToken: input / 1e6,
  outputCostPerToken: output / 1e6,
  cacheReadCostPerToken: cacheRead / 1e6,
  cacheCreationCostPerToken: 0,
  fastMultiplier: 1,
});
const rates: Record<string, ModelRate> = {
  opus: rate(4, 20, 0.4),
  sonnet: rate(2, 10, 0.2),
  fable: rate(10, 50, 1),
};
const rateOf = (model: string) => rates[model] ?? null;
const move = (fromModel: string, toModel: string, tokens = 1_000_000) => ({
  decidedAt: "2026-10-06T18:25:11.891Z",
  fromModel,
  toModel,
  inputTokens: tokens,
  cachedInputTokens: tokens / 2,
  outputTokens: tokens / 10,
});

describe("summarizeSavings", () => {
  it("prices the same tokens on both models, with cached input at the cache price", () => {
    const { lighter, stronger } = summarizeSavings([move("opus", "sonnet")], 0, rateOf);
    // Opus: 0.5M x $4 + 0.5M x $0.40 + 0.1M x $20 = $4.20. Sonnet is half of that.
    expect(lighter).toEqual({ threads: 1, tokens: 1_100_000, microUsd: 2_100_000 });
    expect(stronger).toEqual({ threads: 0, tokens: 0, microUsd: 0 });
  });

  it("counts a move to a dearer model as a cost, not a saving", () => {
    const { lighter, stronger } = summarizeSavings([move("opus", "fable")], 0, rateOf);
    expect(lighter.threads).toBe(0);
    expect(stronger).toEqual({ threads: 1, tokens: 1_100_000, microUsd: 6_300_000 });
  });

  it("leaves a move out rather than guess when a model has no price", () => {
    const savings = summarizeSavings([move("opus", "haiku"), move("opus", "sonnet", 0)], 7, rateOf);
    expect(savings.unpricedThreads).toBe(1);
    // A thread that was moved and never ran still counts as a thread, worth nothing.
    expect(savings.lighter).toEqual({ threads: 1, tokens: 0, microUsd: 0 });
    expect(savings.jevMicroUsd).toBe(7);
    expect(savings.since).toBe("2026-10-06T18:25:11.891Z");
  });

  it("reports nothing counted before any pick stands", () => {
    expect(summarizeSavings([], 0, rateOf)).toMatchObject({ since: null, unpricedThreads: 0 });
  });
});
