import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type JevAdvice,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveLadder } from "./automaticSelection.ts";
import { predictSelection } from "./routingPrediction.ts";

const now = Date.parse("2026-10-06T08:00:00Z");
const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
const claude = ProviderInstanceId.make("claude");
const other = ProviderInstanceId.make("other");

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    status: "ready",
    version: "1",
    auth: { status: "authenticated", profileId: "profile-claude" },
    checkedAt: timestamp,
    models: [
      {
        slug: "haiku",
        name: "Haiku",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              type: "select",
              label: "Effort",
              options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }],
            },
          ],
        },
      },
      { slug: "sonnet", name: "Sonnet", isCustom: false, isDefault: true, capabilities: null },
      { slug: "opus", name: "Opus", isCustom: false, capabilities: null },
    ] as unknown as ServerProvider["models"],
    skills: [],
    slashCommands: [],
    usageLimits: {
      checkedAt: timestamp,
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 10 }],
    },
    ...overrides,
  };
}

const base = {
  providers: [provider()],
  current: { instanceId: claude, model: "sonnet" },
  preference: "balanced" as const,
  pacing: true,
  ladders: {},
  recoveredJev: null,
  now,
};

describe("predictSelection", () => {
  it("picks the small model for a plain question, from local rules", () => {
    expect(predictSelection({ ...base, task: "What does this function do?" })).toMatchObject({
      model: "haiku",
      modelName: "Haiku",
      effort: "low",
      basis: "local",
    });
  });

  it("picks the large model for planning work", () => {
    expect(
      predictSelection({ ...base, task: "Plan the refactor of the billing module" }),
    ).toMatchObject({ model: "opus", basis: "local" });
  });

  it("keeps the chosen model when the text gives no clear signal", () => {
    expect(predictSelection({ ...base, task: "" })).toMatchObject({
      model: "sonnet",
      basis: "local",
    });
  });

  it("uses a Jev judgment that was already recovered, and says so", () => {
    const jev = {
      capability: "advanced",
      effort: "high",
      skillName: null,
      confidence: { capability: 0.9, effort: 0.9, skill: 0 },
    } as unknown as JevAdvice;
    expect(
      predictSelection({ ...base, task: "tidy up the settings page", recoveredJev: jev }),
    ).toMatchObject({ model: "opus", basis: "jev" });
  });

  it("keeps the chosen model when Jev is unsure, whatever keywords the text holds", () => {
    const jev = {
      capability: "basic",
      effort: "low",
      skillName: null,
      confidence: { capability: 0.4, effort: 0.4, skill: 0 },
    } as unknown as JevAdvice;
    expect(
      predictSelection({
        ...base,
        task: "Plan the refactor of the billing module",
        recoveredJev: jev,
      }),
    ).toMatchObject({ model: "sonnet", basis: "jev" });
  });

  it("never turns writing for a reader down, and agrees with the send path", () => {
    const jev = {
      capability: "basic",
      effort: "low",
      skillName: null,
      confidence: { capability: 0.9, effort: 0.9, skill: 0 },
    } as unknown as JevAdvice;
    expect(
      predictSelection({
        ...base,
        task: "update my résumé",
        recoveredJev: jev,
        preference: "save",
      }),
    ).toMatchObject({ model: "sonnet", basis: "jev" });
    expect(predictSelection({ ...base, task: "Can you proofread my cover letter?" })).toMatchObject(
      { model: "sonnet", basis: "local" },
    );
    // Not writing: still turned down.
    expect(
      predictSelection({ ...base, task: "fix the email validation regex", recoveredJev: jev }),
    ).toMatchObject({
      model: "haiku",
    });
  });

  it("applies the quality preference, which lifts a simple task off the smallest model", () => {
    expect(
      predictSelection({ ...base, task: "What does this do?", preference: "quality" })?.model,
    ).toBe("sonnet");
  });

  it("starts on another account when the chosen one is unavailable", () => {
    const blocked = provider({ enabled: false });
    const spare = provider({
      instanceId: other,
      auth: { status: "authenticated", profileId: "profile-other" },
    });
    expect(predictSelection({ ...base, providers: [blocked, spare], task: "" })?.instanceId).toBe(
      other,
    );
  });

  it("returns nothing when the selected account is unknown", () => {
    expect(
      predictSelection({ ...base, current: { instanceId: other, model: "x" }, task: "hi" }),
    ).toBeNull();
  });
});

describe("the ladder is worked out from names and prices", () => {
  const models = (...slugs: string[]) =>
    slugs.map((slug) => ({
      slug: slug.replace(/\*$/, ""),
      name: slug,
      isCustom: false,
      isDefault: slug.endsWith("*"),
      capabilities: null,
    })) as unknown as ServerProvider["models"];
  const prices = (table: Record<string, number>) => (model: string) => table[model] ?? null;
  // Real lists and list prices (per million tokens, input plus output) from one server.
  const codex = provider({
    driver: ProviderDriverKind.make("codex"),
    models: models(
      "gpt-6.1-sol",
      "gpt-6-astra*",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ),
  });
  const codexPrices = prices({
    "gpt-6.1-sol": 12,
    "gpt-6-astra": 60,
    "gpt-6-sol": 12,
    "gpt-6-luna": 0.6,
    "gpt-5.6-sol": 24,
    "gpt-5.6-terra": 14,
    "gpt-5.6-luna": 1.4,
  });

  it("orders a family by price when its names say nothing about size", () => {
    expect(resolveLadder(codex, undefined, codexPrices)).toEqual({
      basic: "gpt-6-luna",
      standard: "gpt-6.1-sol",
      advanced: "gpt-6-astra",
    });
  });

  it("keeps a rung the person chose and works out the rest", () => {
    expect(resolveLadder(codex, { standard: "gpt-5.6-terra" }, codexPrices)).toEqual({
      basic: "gpt-6-luna",
      standard: "gpt-5.6-terra",
      advanced: "gpt-6-astra",
    });
  });

  it("uses names where they are clear, whatever the prices", () => {
    const grok = provider({
      driver: ProviderDriverKind.make("grok"),
      models: models("grok-4.7*", "grok-4.7-build-fast", "grok-4.6"),
    });
    expect(resolveLadder(grok, undefined, prices({ "grok-4.7": 8, "grok-4.6": 8 }))).toEqual({
      basic: "grok-4.7-build-fast",
      standard: "grok-4.7",
    });
  });

  it("makes no ladder from one price, and two rungs from two", () => {
    const flat = provider({
      driver: ProviderDriverKind.make("other"),
      models: models("alpha*", "beta"),
    });
    expect(resolveLadder(flat, undefined, prices({ alpha: 5, beta: 5 }))).toEqual({
      standard: "alpha",
    });
    expect(resolveLadder(flat, undefined, prices({ alpha: 5, beta: 20 }))).toEqual({
      standard: "alpha",
      advanced: "beta",
    });
    expect(resolveLadder(flat, undefined, prices({ alpha: 5, beta: 1 }))).toEqual({
      basic: "beta",
      standard: "alpha",
    });
  });

  it("never moves hard work to a cheaper model, even from the account's default", () => {
    const jev = {
      capability: "advanced",
      effort: "high",
      skillName: null,
      confidence: { capability: 0.9, effort: 0.9, skill: 0 },
    } as unknown as JevAdvice;
    const withFable = provider({ models: models("opus", "sonnet", "fable*", "haiku") });
    const priceOf = prices({ opus: 24, sonnet: 12, fable: 60 });
    const from = (model: string) =>
      predictSelection({
        ...base,
        providers: [withFable],
        current: { instanceId: claude, model },
        task: "Find out why checkout charges twice",
        recoveredJev: jev,
        priceOf,
      })?.model;
    expect(from("fable")).toBe("fable");
    expect(from("sonnet")).toBe("opus");
  });
});
