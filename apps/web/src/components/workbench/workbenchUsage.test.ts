import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { currentProviderUsageLabel, currentProviderUsageTone, usageAlert } from "./workbenchUsage";

it("does not attribute a subscription to an API provider sharing its driver", () => {
  expect(
    currentProviderUsageLabel({
      driver: ProviderDriverKind.make("codex"),
      displayName: "OpenRouter",
    }),
  ).toBe("OpenRouter · Usage Unavailable");
  expect(
    currentProviderUsageLabel({
      driver: ProviderDriverKind.make("codex"),
      displayName: "CheaperInference",
    }),
  ).toBe("CheaperInference · Usage Unavailable");
  expect(currentProviderUsageLabel(undefined)).toBe("Subscription Usage");
});

it("uses the selected account's limiting weekly window and preserves probe failures", () => {
  expect(
    currentProviderUsageLabel({
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok Account 2",
      usageLimits: {
        checkedAt: "2026-10-03T05:00:00Z",
        windows: [
          { id: "session", kind: "session", label: "Session", usedPercent: 95 },
          { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 25 },
          { id: "weekly-build", kind: "weekly", label: "Build", usedPercent: 80 },
        ],
        unavailable: { reason: "probeFailed" },
      },
    }),
  ).toBe("Grok Account 2 · Weekly 20% Left · Last Reported");
});

it("shows a reported nonweekly allowance without relabeling it weekly", () => {
  expect(
    currentProviderUsageLabel({
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
      usageLimits: {
        checkedAt: "2026-10-03T05:00:00Z",
        windows: [{ id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 10 }],
      },
    }),
  ).toBe("Cursor · Monthly 90% Left");
});

it("names the allowance the selected model draws on when that allowance is used up", () => {
  const usageLimits = {
    checkedAt: "2026-10-05T22:09:20.748Z",
    windows: [
      {
        id: "apiPercentUsed",
        kind: "monthly" as const,
        label: "Other Models",
        usedPercent: 100,
        resetsAt: "2026-10-17T04:46:32.000Z",
      },
      {
        id: "autoPercentUsed",
        kind: "monthly" as const,
        label: "Cursor Models",
        usedPercent: 24,
        resetsAt: "2026-10-17T04:46:32.000Z",
      },
      { id: "totalPercentUsed", kind: "monthly" as const, label: "Overall", usedPercent: 27 },
    ],
  };
  const provider = {
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor",
    usageLimits,
  };
  expect(currentProviderUsageLabel(provider, "claude-opus-5-5")).toBe(
    "Cursor · Other Models used up",
  );
  expect(currentProviderUsageLabel(provider, "composer-2")).toBe("Cursor · Cursor Models 76% Left");
  expect(currentProviderUsageTone(provider, "claude-opus-5-5")).toBe("empty");
  expect(currentProviderUsageTone(provider, "composer-2")).toBe("steady");
});

const alertAccount = (
  displayName: string,
  windows: Array<{ kind: "weekly" | "session"; label: string; usedPercent: number }>,
) =>
  ({
    key: displayName,
    driver: ProviderDriverKind.make("codex"),
    displayName,
    limits: {
      checkedAt: "2026-10-03T05:00:00Z",
      windows: windows.map((w, i) => ({ id: `w${i}`, ...w })),
    },
  }) as unknown as LimitAccount;

it("flags an exhausted allowance red and one under 10% left amber", () => {
  expect(usageAlert([])).toBeNull();
  expect(
    usageAlert([alertAccount("Codex", [{ kind: "weekly", label: "Weekly", usedPercent: 89 }])]),
  ).toBeNull();
  expect(
    usageAlert([alertAccount("Codex", [{ kind: "weekly", label: "Weekly", usedPercent: 91 }])]),
  ).toEqual({ level: "low", message: "Codex weekly allowance is almost used up (9% left)" });
  expect(
    usageAlert([alertAccount("Codex", [{ kind: "weekly", label: "Weekly", usedPercent: 100 }])]),
  ).toEqual({ level: "empty", message: "Codex weekly allowance is used up" });
});

it("reports the worst allowance across accounts and counts the rest", () => {
  expect(
    usageAlert([
      alertAccount("Claude", [{ kind: "session", label: "5 Hour", usedPercent: 95 }]),
      alertAccount("Codex", [{ kind: "weekly", label: "Weekly", usedPercent: 100 }]),
      alertAccount("Grok", [{ kind: "weekly", label: "Weekly", usedPercent: 10 }]),
    ]),
  ).toEqual({ level: "empty", message: "Codex weekly allowance is used up, and 1 more" });
});

it("colors the top bar button by what is left: green, amber under a quarter, red when empty", () => {
  const provider = (usedPercent: number) => ({
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    usageLimits: {
      checkedAt: "2026-10-03T05:00:00Z",
      windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent }],
    },
  });
  expect(currentProviderUsageTone(provider(50))).toBe("steady");
  expect(currentProviderUsageTone(provider(80))).toBe("low");
  expect(currentProviderUsageTone(provider(100))).toBe("empty");
  expect(currentProviderUsageTone(undefined)).toBeNull();
});
