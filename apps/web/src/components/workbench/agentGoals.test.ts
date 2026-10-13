import type { WorkbenchAgentGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_GOAL_DRAFT, goalDraftToFields, goalToDraft } from "./agentGoals";

describe("goalDraftToFields", () => {
  const filled = {
    ...EMPTY_GOAL_DRAFT,
    title: "  Keep the inbox clear ",
    outcome: " Zero unread ",
  };

  it("starts a new goal as Propose Only on weekdays at 9", () => {
    expect(EMPTY_GOAL_DRAFT.autonomy).toBe("propose");
    expect(goalDraftToFields(filled)).toEqual({
      ok: true,
      fields: {
        title: "Keep the inbox clear",
        outcome: "Zero unread",
        autonomy: "propose",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      },
    });
  });

  it("asks for a title and an outcome", () => {
    expect(goalDraftToFields({ ...filled, title: "  " })).toMatchObject({ ok: false });
    expect(goalDraftToFields({ ...filled, outcome: "" })).toMatchObject({ ok: false });
  });

  it("rejects an interval under a minute or not a number", () => {
    const interval = { ...filled, scheduleMode: "interval" as const };
    expect(goalDraftToFields({ ...interval, intervalMinutes: "0.5" })).toMatchObject({ ok: false });
    expect(goalDraftToFields({ ...interval, intervalMinutes: "" })).toMatchObject({ ok: false });
    expect(goalDraftToFields({ ...interval, intervalMinutes: "abc" })).toMatchObject({ ok: false });
    expect(goalDraftToFields({ ...interval, intervalMinutes: "30" })).toMatchObject({
      ok: true,
      fields: { schedule: { type: "interval", everyMs: 1_800_000 } },
    });
  });

  it("rejects a time that is not HH:MM", () => {
    expect(goalDraftToFields({ ...filled, timeOfDay: "25:00" })).toMatchObject({ ok: false });
  });

  it("falls back to 9:00 when the time field is cleared", () => {
    expect(goalDraftToFields({ ...filled, timeOfDay: "" })).toMatchObject({
      ok: true,
      fields: { schedule: { timeOfDay: "09:00" } },
    });
  });
});

describe("goalToDraft", () => {
  it("round-trips a goal through the form", () => {
    const goal = {
      id: "goal-1",
      title: "Weekly report",
      outcome: "A report in the shared folder",
      schedule: { type: "fixed_time", timeOfDay: "16:30", weekdays: [5] },
      autonomy: "act_and_report",
      status: "active",
      scheduledTaskId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as unknown as WorkbenchAgentGoal;
    const result = goalDraftToFields(goalToDraft(goal));
    expect(goalToDraft(goal).goalId).toBe("goal-1");
    expect(result).toMatchObject({
      ok: true,
      fields: {
        title: goal.title,
        outcome: goal.outcome,
        autonomy: "act_and_report",
        schedule: goal.schedule,
      },
    });
  });
});
