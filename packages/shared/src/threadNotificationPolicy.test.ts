import { describe, expect, it } from "vite-plus/test";

import {
  decideThreadNotification,
  isWithinQuietHours,
  parseClockMinutes,
  runDurationSeconds,
  type ThreadNotificationDecisionInput,
} from "./threadNotificationPolicy.ts";
import type { ThreadNotificationKind } from "./threadNotificationText.ts";

const base = { runDurationSeconds: 5 } as const;

describe("decideThreadNotification", () => {
  it.each([["failed"], ["waiting_for_input"], ["waiting_for_approval"], ["limited"]] as const)(
    "always notifies for %s, even after a 1 second run",
    (kind) => {
      expect(decideThreadNotification({ kind, runDurationSeconds: 1, minRunSeconds: 600 })).toEqual(
        {
          notify: true,
          reason: "needs_person",
        },
      );
    },
  );

  it.each<[string, ThreadNotificationDecisionInput, boolean, string]>([
    ["short reply stays silent", { kind: "completed", ...base }, false, "short_run"],
    [
      "one second under the limit",
      { kind: "completed", runDurationSeconds: 59.9 },
      false,
      "short_run",
    ],
    ["exactly the limit notifies", { kind: "completed", runDurationSeconds: 60 }, true, "long_run"],
    ["3 minute run", { kind: "completed", runDurationSeconds: 180 }, true, "long_run"],
    [
      "custom limit boundary, under",
      { kind: "completed", runDurationSeconds: 179, minRunSeconds: 180 },
      false,
      "short_run",
    ],
    [
      "custom limit boundary, exact",
      { kind: "completed", runDurationSeconds: 180, minRunSeconds: 180 },
      true,
      "long_run",
    ],
    [
      "zero setting notifies every completion",
      { kind: "completed", runDurationSeconds: 0.5, minRunSeconds: 0 },
      true,
      "any_length",
    ],
    [
      "unknown duration counts as long",
      { kind: "completed", runDurationSeconds: null },
      true,
      "unknown_duration",
    ],
    [
      "zero setting with unknown duration",
      { kind: "completed", runDurationSeconds: null, minRunSeconds: 0 },
      true,
      "any_length",
    ],
  ])("completed: %s", (_name, input, notify, reason) => {
    expect(decideThreadNotification(input)).toEqual({ notify, reason });
  });

  it.each([
    "completed",
    "failed",
    "waiting_for_input",
    "waiting_for_approval",
    "limited",
  ] as const satisfies ReadonlyArray<ThreadNotificationKind>)(
    "stays silent for the thread being looked at (%s)",
    (kind) => {
      expect(
        decideThreadNotification({ kind, runDurationSeconds: 900, viewingThread: true }),
      ).toEqual({ notify: false, reason: "viewing_thread" });
    },
  );

  it("never notifies for subagents", () => {
    expect(
      decideThreadNotification({ kind: "failed", runDurationSeconds: 900, isSubagent: true }),
    ).toEqual({ notify: false, reason: "subagent" });
  });

  describe("quiet hours across midnight (22:00 to 07:00)", () => {
    const quietHours = { startMinute: 22 * 60, endMinute: 7 * 60 };
    it.each([
      [23 * 60, "completed", false, "quiet_hours"],
      [0, "completed", false, "quiet_hours"],
      [6 * 60 + 59, "completed", false, "quiet_hours"],
      [22 * 60, "completed", false, "quiet_hours"],
      [7 * 60, "completed", true, "long_run"],
      [12 * 60, "completed", true, "long_run"],
      [23 * 60, "failed", true, "needs_person"],
      [0, "waiting_for_input", true, "needs_person"],
      [3 * 60, "waiting_for_approval", true, "needs_person"],
      [3 * 60, "limited", true, "needs_person"],
    ] as const)("at minute %s, %s", (localMinuteOfDay, kind, notify, reason) => {
      expect(
        decideThreadNotification({
          kind,
          runDurationSeconds: 900,
          quietHours,
          localMinuteOfDay,
        }),
      ).toEqual({ notify, reason });
    });

    it("ignores quiet hours when the local time is unknown", () => {
      expect(
        decideThreadNotification({ kind: "completed", runDurationSeconds: 900, quietHours }).notify,
      ).toBe(true);
    });
  });
});

describe("isWithinQuietHours", () => {
  it("handles a same-day period and an empty one", () => {
    const daytime = { startMinute: 13 * 60, endMinute: 14 * 60 };
    expect(isWithinQuietHours(13 * 60, daytime)).toBe(true);
    expect(isWithinQuietHours(14 * 60, daytime)).toBe(false);
    expect(isWithinQuietHours(60, { startMinute: 60, endMinute: 60 })).toBe(false);
  });
});

describe("parseClockMinutes", () => {
  it.each([
    ["00:00", 0],
    ["07:30", 450],
    ["23:59", 1439],
    ["24:00", null],
    ["7:30", null],
    ["", null],
  ] as const)("%s", (value, minutes) => {
    expect(parseClockMinutes(value)).toBe(minutes);
  });
});

describe("runDurationSeconds", () => {
  it.each([
    ["2026-10-05T10:00:00.000Z", "2026-10-05T10:01:30.500Z", 90.5],
    ["2026-10-05T10:00:00.000Z", null, null],
    [null, "2026-10-05T10:00:00.000Z", null],
    ["not a date", "2026-10-05T10:00:00.000Z", null],
    ["2026-10-05T10:00:10.000Z", "2026-10-05T10:00:00.000Z", null],
  ] as const)("%s to %s", (start, end, seconds) => {
    expect(runDurationSeconds(start, end)).toBe(seconds);
  });
});
