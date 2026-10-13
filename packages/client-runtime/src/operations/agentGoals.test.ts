import { AgentGoalError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkGoalFields,
  describeSchedule,
  formatTimeOfDay,
  goalErrorMessage,
  goalErrorReason,
  goalStatusLabel,
} from "./agentGoals.ts";

describe("formatTimeOfDay", () => {
  it("uses a 12-hour clock", () => {
    expect(formatTimeOfDay("09:00")).toBe("9:00 AM");
    expect(formatTimeOfDay("13:05")).toBe("1:05 PM");
    expect(formatTimeOfDay("00:30")).toBe("12:30 AM");
    expect(formatTimeOfDay("12:00")).toBe("12:00 PM");
    expect(formatTimeOfDay("soon")).toBe("soon");
  });
});

describe("describeSchedule", () => {
  it("describes fixed times by the days they run", () => {
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "09:00" })).toBe(
      "Every Day At 9:00 AM",
    );
    expect(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toBe("Every Day At 9:00 AM");
    expect(
      describeSchedule({ type: "fixed_time", timeOfDay: "18:30", weekdays: [5, 4, 3, 2, 1] }),
    ).toBe("Weekdays At 6:30 PM");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "10:00", weekdays: [6, 0] })).toBe(
      "Weekends At 10:00 AM",
    );
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "07:15", weekdays: [3, 1, 5] })).toBe(
      "Mon, Wed, Fri At 7:15 AM",
    );
  });

  it("describes intervals in the largest whole unit", () => {
    expect(describeSchedule({ type: "interval", everyMs: 60_000 })).toBe("Every Minute");
    expect(describeSchedule({ type: "interval", everyMs: 15 * 60_000 })).toBe("Every 15 Minutes");
    expect(describeSchedule({ type: "interval", everyMs: 60 * 60_000 })).toBe("Every Hour");
    expect(describeSchedule({ type: "interval", everyMs: 120 * 60_000 })).toBe("Every 2 Hours");
    expect(describeSchedule({ type: "interval", everyMs: 90 * 60_000 })).toBe("Every 90 Minutes");
    expect(describeSchedule({ type: "interval", everyMs: 1440 * 60_000 })).toBe("Every Day");
    expect(describeSchedule({ type: "interval", everyMs: 2880 * 60_000 })).toBe("Every 2 Days");
  });
});

describe("goalStatusLabel", () => {
  it("says why a goal the server stopped is paused", () => {
    expect(goalStatusLabel({ status: "paused", pausedReason: "unreviewed_limit" })).toBe(
      "Paused: 5 Check-Ins Waiting For Review",
    );
  });

  it("keeps an owner pause and the other statuses short", () => {
    expect(goalStatusLabel({ status: "paused", pausedReason: "owner" })).toBe("Paused");
    expect(goalStatusLabel({ status: "paused" })).toBe("Paused");
    expect(goalStatusLabel({ status: "active" })).toBe("Active");
    expect(goalStatusLabel({ status: "done" })).toBe("Done");
  });

  it("ignores a stale paused reason on a goal that is no longer paused", () => {
    expect(goalStatusLabel({ status: "active", pausedReason: "unreviewed_limit" })).toBe("Active");
  });
});

describe("goalErrorMessage", () => {
  it("explains each failure in a sentence", () => {
    const message = (reason: AgentGoalError["reason"]) =>
      goalErrorMessage(new AgentGoalError({ reason }));
    expect(message("no_primary_thread")).toBe(
      "Start a conversation with this agent before giving it a goal.",
    );
    expect(message("goal_limit")).toBe("An agent can hold up to 20 goals.");
    expect(message("note_required")).toMatch(/note/i);
    for (const reason of [
      "agent_not_found",
      "agent_archived",
      "goal_not_found",
      "checkin_not_found",
      "already_reviewed",
      "invalid_cursor",
      "conflict",
      "thread_unavailable",
      "task_failed",
      "storage",
    ] as const) {
      expect(message(reason)).not.toMatch(/_/);
      expect(message(reason).length).toBeGreaterThan(10);
    }
  });

  it("recognises the error, and gives a generic line for anything else", () => {
    expect(goalErrorReason(new AgentGoalError({ reason: "storage" }))).toBe("storage");
    expect(goalErrorReason(new Error("boom"))).toBeNull();
    expect(goalErrorReason(null)).toBeNull();
    expect(goalErrorReason({ _tag: "AgentGoalError", reason: "nonsense" })).toBeNull();
    expect(goalErrorMessage(new Error("boom"))).toMatch(/try again/i);
  });
});

describe("checkGoalFields", () => {
  const filled = {
    title: "  Keep the inbox clear ",
    outcome: " Zero unread ",
    autonomy: "propose" as const,
    schedule: { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  };

  it("trims the words and passes the schedule and autonomy through", () => {
    expect(checkGoalFields(filled)).toEqual({
      ok: true,
      fields: {
        title: "Keep the inbox clear",
        outcome: "Zero unread",
        autonomy: "propose",
        schedule: filled.schedule,
      },
    });
  });

  it("asks for a title and an outcome", () => {
    expect(checkGoalFields({ ...filled, title: "  " })).toMatchObject({ ok: false });
    expect(checkGoalFields({ ...filled, outcome: "" })).toMatchObject({ ok: false });
  });

  it("rejects an interval under a minute", () => {
    expect(
      checkGoalFields({ ...filled, schedule: { type: "interval", everyMs: 30_000 } }),
    ).toMatchObject({ ok: false });
    expect(
      checkGoalFields({ ...filled, schedule: { type: "interval", everyMs: Number.NaN } }),
    ).toMatchObject({ ok: false });
    expect(
      checkGoalFields({ ...filled, schedule: { type: "interval", everyMs: 1_800_000 } }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a time that is not HH:MM", () => {
    expect(
      checkGoalFields({ ...filled, schedule: { type: "fixed_time", timeOfDay: "25:00" } }),
    ).toMatchObject({ ok: false });
  });

  it("reports a schedule the form could not build", () => {
    expect(checkGoalFields({ ...filled, schedule: null })).toMatchObject({ ok: false });
  });
});
