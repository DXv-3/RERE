import { describe, expect, it } from "@effect/vitest";

import { appIconBadgeCount } from "./appIconBadge";

const thread = (overrides: Record<string, unknown> = {}) =>
  ({
    archivedAt: null,
    lineage: { relationshipToParent: null },
    settledOverride: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    ...overrides,
  }) as never;

const now = Date.parse("2026-10-12T12:00:00.000Z");

describe("appIconBadgeCount", () => {
  it("counts the threads that show Done, a question or a failure", () => {
    expect(
      appIconBadgeCount(
        [
          thread({
            latestRun: { completedAt: "2026-10-12T11:00:00.000Z" },
            lastVisitedAt: "2026-10-12T10:00:00.000Z",
          }),
          thread({ hasPendingUserInput: true }),
          thread({ runtime: { status: "failed" } }),
          thread({
            latestRun: { completedAt: "2026-10-12T09:00:00.000Z" },
            lastVisitedAt: "2026-10-12T10:00:00.000Z",
          }),
        ],
        now,
      ),
    ).toBe(3);
  });

  it("drops a thread once it is opened after it finished, or snoozed", () => {
    const finished = { latestRun: { completedAt: "2026-10-12T11:00:00.000Z" } };
    expect(
      appIconBadgeCount([thread({ ...finished, lastVisitedAt: "2026-10-12T11:30:00.000Z" })], now),
    ).toBe(0);
    expect(
      appIconBadgeCount(
        [
          thread({
            ...finished,
            lastVisitedAt: "2026-10-12T10:00:00.000Z",
            snoozedUntil: "2026-10-13T00:00:00.000Z",
          }),
        ],
        now,
      ),
    ).toBe(0);
  });
});
