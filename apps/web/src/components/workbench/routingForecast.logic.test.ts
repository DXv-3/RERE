import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type RoutingPrediction } from "@t3tools/contracts";
import {
  createDebouncedRunner,
  FORECAST_DEBOUNCE_MS,
  forecastLine,
  modelLabel,
  selectionEffort,
} from "./routingForecast.logic";

const claude = ProviderInstanceId.make("claude");
const predicted = (overrides: Partial<RoutingPrediction> = {}): RoutingPrediction => ({
  instanceId: claude,
  model: "sonnet",
  modelName: "Claude Sonnet 5",
  effort: "medium",
  basis: "local",
  ...overrides,
});

describe("forecastLine", () => {
  it("says likely for a local-only guess on a new thread", () => {
    expect(
      forecastLine({ mode: "automatic", newThread: true, predicted: predicted(), current: null }),
    ).toBe("Auto will likely pick: Claude Sonnet 5 · medium effort");
  });

  it("drops likely once Jev has judged the text", () => {
    expect(
      forecastLine({
        mode: "automatic",
        newThread: true,
        predicted: predicted({ basis: "jev", effort: null }),
        current: null,
      }),
    ).toBe("Auto will pick: Claude Sonnet 5");
  });

  it("shows nothing on a new thread until there is an answer", () => {
    expect(
      forecastLine({ mode: "automatic", newThread: true, predicted: null, current: null }),
    ).toBeNull();
  });

  it("stays quiet on a running thread: the picker already shows its model", () => {
    expect(
      forecastLine({
        mode: "automatic",
        newThread: false,
        predicted: predicted(),
        current: { name: "Claude Opus 5", effort: "high" },
      }),
    ).toBeNull();
  });

  it("stays quiet when the pick is what the picker already shows", () => {
    const same = { name: "Claude Sonnet 5", effort: "medium" };
    expect(
      forecastLine({ mode: "automatic", newThread: true, predicted: predicted(), current: same }),
    ).toBeNull();
    // An effort the picker does not state is not a difference.
    expect(
      forecastLine({
        mode: "automatic",
        newThread: true,
        predicted: predicted(),
        current: { ...same, effort: null },
      }),
    ).toBeNull();
    expect(
      forecastLine({
        mode: "automatic",
        newThread: true,
        predicted: predicted({ effort: "high" }),
        current: same,
      }),
    ).toBe("Auto will likely pick: Claude Sonnet 5 · high effort");
  });

  it.each(["manual", "shadow"] as const)("shows nothing in %s mode", (mode) => {
    expect(
      forecastLine({
        mode,
        newThread: true,
        predicted: predicted(),
        current: { name: "x", effort: null },
      }),
    ).toBeNull();
  });
});

describe("selection helpers", () => {
  it("reads the effort a selection sets", () => {
    expect(
      selectionEffort({
        instanceId: claude,
        model: "m",
        options: [{ id: "effort", value: "low" }],
      }),
    ).toBe("low");
    expect(selectionEffort({ instanceId: claude, model: "m" })).toBeNull();
  });

  it("names a model from its account, or falls back to the id", () => {
    const providers = [
      { instanceId: claude, models: [{ slug: "sonnet", name: "Claude Sonnet 5" }] },
    ] as unknown as Parameters<typeof modelLabel>[0];
    expect(modelLabel(providers, { instanceId: claude, model: "sonnet" })).toBe("Claude Sonnet 5");
    expect(modelLabel(providers, { instanceId: claude, model: "other" })).toBe("other");
  });
});

describe("createDebouncedRunner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after typing pauses, however many keystrokes came before", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run);
    for (let i = 0; i < 5; i++) {
      runner.schedule();
      vi.advanceTimersByTime(FORECAST_DEBOUNCE_MS - 100);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not run once cancelled, as when the message is sent", () => {
    const run = vi.fn();
    const runner = createDebouncedRunner(run);
    runner.schedule();
    runner.cancel();
    vi.advanceTimersByTime(FORECAST_DEBOUNCE_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});
