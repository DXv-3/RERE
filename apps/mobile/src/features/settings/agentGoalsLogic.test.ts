import type { EnvironmentId, WorkbenchAgentGoal, WorkspaceAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_GOAL_DRAFT,
  ageLabel,
  applyAgentToEntries,
  goalDraftToFields,
  goalToDraft,
  mergeLoadedEntries,
  textMayOverflow,
  type AgentEntry,
} from "./agentGoalsLogic";

const env = (id: string) => id as EnvironmentId;
const entry = (environmentId: string, agentId: string, revision: number): AgentEntry => ({
  environmentId: env(environmentId),
  agent: { profile: { id: agentId }, revision } as unknown as WorkspaceAgent,
});
const revisions = (entries: ReadonlyArray<AgentEntry>) =>
  entries.map((e) => `${e.environmentId}/${e.agent.profile.id}@${e.agent.revision}`);

describe("applyAgentToEntries", () => {
  it("takes the returned agent so the next save carries the new revision", () => {
    const entries = [entry("a", "bot", 3), entry("a", "other", 1)];
    const next = applyAgentToEntries(entries, env("a"), entry("a", "bot", 4).agent);
    expect(revisions(next)).toEqual(["a/bot@4", "a/other@1"]);
  });

  it("never puts an agent from one environment into another environment's entry", () => {
    const entries = [entry("a", "bot", 3), entry("b", "bot", 7)];
    const next = applyAgentToEntries(entries, env("b"), entry("b", "bot", 8).agent);
    expect(revisions(next)).toEqual(["a/bot@3", "b/bot@8"]);
  });

  it("does not add an agent the screen does not hold", () => {
    const entries = [entry("a", "bot", 3)];
    expect(applyAgentToEntries(entries, env("a"), entry("a", "ghost", 1).agent)).toEqual(entries);
  });

  it("keeps a copy that is already newer", () => {
    const entries = [entry("a", "bot", 5)];
    expect(revisions(applyAgentToEntries(entries, env("a"), entry("a", "bot", 4).agent))).toEqual([
      "a/bot@5",
    ]);
  });
});

describe("mergeLoadedEntries", () => {
  it("keeps a held copy newer than what the server just listed, per environment", () => {
    const held = [entry("a", "bot", 6), entry("b", "bot", 2)];
    const loaded = [entry("a", "bot", 5), entry("b", "bot", 3), entry("a", "new", 1)];
    expect(revisions(mergeLoadedEntries(held, loaded))).toEqual(["a/bot@6", "b/bot@3", "a/new@1"]);
  });
});

describe("goal drafts", () => {
  const filled = { ...EMPTY_GOAL_DRAFT, title: " Keep the inbox clear ", outcome: " Zero unread " };

  it("starts a new goal as Propose Only on weekdays at 9", () => {
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

  it("explains an unusable schedule instead of sending it", () => {
    const noDays = { ...filled, schedule: { ...filled.schedule, weekdays: [] } };
    expect(goalDraftToFields(noDays)).toMatchObject({ ok: false });
    const short = {
      ...filled,
      schedule: { ...filled.schedule, mode: "interval" as const, intervalMinutes: "0.5" },
    };
    expect(goalDraftToFields(short)).toMatchObject({ ok: false });
  });

  it("round-trips a goal through the form", () => {
    const goal = {
      id: "goal-1",
      title: "Weekly report",
      outcome: "A report in the shared folder",
      schedule: { type: "interval", everyMs: 7_200_000 },
      autonomy: "act_and_report",
      status: "active",
      scheduledTaskId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as unknown as WorkbenchAgentGoal;
    const draft = goalToDraft(goal);
    expect(draft.goalId).toBe("goal-1");
    expect(goalDraftToFields(draft)).toMatchObject({
      ok: true,
      fields: { autonomy: "act_and_report", schedule: goal.schedule },
    });
  });
});

describe("textMayOverflow", () => {
  it("is quiet for short text and loud for long text or many lines", () => {
    expect(textMayOverflow("Short.", 3)).toBe(false);
    expect(textMayOverflow("a\nb\nc", 3)).toBe(false);
    expect(textMayOverflow("a\nb\nc\nd", 3)).toBe(true);
    expect(textMayOverflow("x".repeat(200), 3)).toBe(true);
  });
});

describe("ageLabel", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  it("says how long ago in the largest whole unit", () => {
    expect(ageLabel("2026-10-05T11:59:40.000Z", now)).toBe("Just now");
    expect(ageLabel("2026-10-05T11:59:00.000Z", now)).toBe("1 minute ago");
    expect(ageLabel("2026-10-05T11:15:00.000Z", now)).toBe("45 minutes ago");
    expect(ageLabel("2026-10-05T10:00:00.000Z", now)).toBe("2 hours ago");
    expect(ageLabel("2026-10-02T12:00:00.000Z", now)).toBe("3 days ago");
    expect(ageLabel("2026-10-06T12:00:00.000Z", now)).toBe("Just now");
    expect(ageLabel("not a date", now)).toBe("Earlier");
  });
});
