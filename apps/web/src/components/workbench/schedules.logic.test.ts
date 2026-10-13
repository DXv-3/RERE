import type { ScheduledTask, WorkbenchAgentGoal, WorkspaceAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildScheduleRows, scheduleSummary, whenInWords } from "./schedules.logic";

const NOW = new Date("2026-10-06T15:00:00Z");
const UTC = { timeZone: "UTC" } as const;

describe("whenInWords", () => {
  const words = (iso: string) => whenInWords(iso, NOW, UTC);
  it("speaks of the near future in minutes", () => {
    expect(words("2026-10-06T15:00:30Z")).toBe("In under a minute");
    expect(words("2026-10-06T15:01:00Z")).toBe("In 1 minute");
    expect(words("2026-10-06T15:45:00Z")).toBe("In 45 minutes");
  });
  it("speaks of today, tomorrow and the week by name", () => {
    expect(words("2026-10-06T21:30:00Z")).toBe("Today at 9:30 PM");
    expect(words("2026-10-07T09:00:00Z")).toBe("Tomorrow at 9:00 AM");
    expect(words("2026-10-09T09:00:00Z")).toBe("Friday at 9:00 AM");
    expect(words("2026-10-20T09:00:00Z")).toBe("Oct 20 at 9:00 AM");
  });
  it("speaks of the past", () => {
    expect(words("2026-10-06T14:59:40Z")).toBe("Just now");
    expect(words("2026-10-06T14:48:00Z")).toBe("12 minutes ago");
    expect(words("2026-10-06T08:00:00Z")).toBe("Today at 8:00 AM");
    expect(words("2026-10-05T08:00:00Z")).toBe("Yesterday at 8:00 AM");
    expect(words("2026-10-02T08:00:00Z")).toBe("Last Friday at 8:00 AM");
    expect(words("2026-09-01T08:00:00Z")).toBe("Sep 1 at 8:00 AM");
  });
  it("counts days in the viewer's own time zone", () => {
    // 02:00 UTC on the 7th is still the evening of the 6th in New York.
    expect(whenInWords("2026-10-07T02:00:00Z", NOW, { timeZone: "America/New_York" })).toBe(
      "Today at 10:00 PM",
    );
  });
  it("gives nothing for a bad time", () => {
    expect(words("nope")).toBeNull();
  });
});

const task = (patch: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({
    id: "task-1",
    title: "Morning check",
    prompt: "Look at the\n  campaign board and report.",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    projectId: "p",
    threadId: null,
    createdBy: "user",
    nextRunAt: "2026-10-07T09:00:00Z",
    lastRunAt: "2026-10-06T09:00:00Z",
    lastRunStatus: "succeeded",
    lastRunError: null,
    runCount: 3,
    ...patch,
  }) as ScheduledTask;

const goal = (patch: Partial<WorkbenchAgentGoal> = {}): WorkbenchAgentGoal =>
  ({
    id: "g1",
    title: "Weekly reels",
    outcome: "Keep three reels ready each week.",
    schedule: { type: "fixed_time", timeOfDay: "08:00", weekdays: [1] },
    autonomy: "propose",
    status: "active",
    scheduledTaskId: "agent-goal:g1",
    ...patch,
  }) as WorkbenchAgentGoal;

const agent = (goals: WorkbenchAgentGoal[], patch: Partial<WorkspaceAgent> = {}): WorkspaceAgent =>
  ({
    profile: { id: "a1", name: "Ava" },
    primaryThreadId: "thread-a",
    goals,
    ...patch,
  }) as unknown as WorkspaceAgent;

const rows = (tasks: ScheduledTask[], agents: WorkspaceAgent[] = []) =>
  buildScheduleRows({ tasks, agents, now: NOW, timeZone: "UTC" });

describe("buildScheduleRows: tasks", () => {
  it("describes a plain task in words", () => {
    const [row] = rows([task()]);
    expect(row).toMatchObject({
      kind: "task",
      title: "Morning check",
      doing: "Look at the campaign board and report.",
      cadence: "Weekdays At 9:00 AM",
      stateLabel: "On",
      nextRun: "Tomorrow at 9:00 AM",
      lastRun: "Today at 9:00 AM",
      lastResult: "Succeeded",
      canPause: true,
      canResume: false,
      canRunNow: true,
      canOpen: false,
      ownerLabel: "No thread",
    });
  });

  it("offers Resume and no next run for a paused task", () => {
    const [row] = rows([task({ enabled: false, nextRunAt: null })]);
    expect(row).toMatchObject({
      stateLabel: "Paused",
      nextRun: "Not while it is paused",
      canPause: false,
      canResume: true,
    });
  });

  it("shows why the last run failed", () => {
    const [row] = rows([task({ lastRunStatus: "failed", lastRunError: "Thread was archived." })]);
    expect(row?.lastResult).toBe("Failed: Thread was archived.");
    expect(row?.lastResultFailed).toBe(true);
  });

  it("says a task that has never run has not run", () => {
    const [row] = rows([task({ lastRunStatus: "never", lastRunAt: null })]);
    expect(row).toMatchObject({ lastRun: "Has not run yet", lastResult: "Has not run yet" });
  });

  it("calls a past next run due, and a running task running", () => {
    expect(rows([task({ nextRunAt: "2026-10-06T14:00:00Z" })])[0]?.nextRun).toBe("Due now");
    const [running] = rows([task({ lastRunStatus: "running" })]);
    expect(running).toMatchObject({
      stateLabel: "Running Now",
      nextRun: "After this run finishes",
      canRunNow: false,
    });
  });

  it("names the agent whose thread it runs in, and can open it", () => {
    const [row] = rows([task({ threadId: "thread-a" as never })], [agent([])]);
    expect(row).toMatchObject({ ownerLabel: "Ava", canOpen: true, agentId: "a1" });
    expect(row?.owner).toEqual({ kind: "agent", agentId: "a1", name: "Ava" });
    const other = rows([task({ threadId: "thread-z" as never })], [agent([])])[0];
    expect(other).toMatchObject({ ownerLabel: "A thread", canOpen: true, agentId: null });
  });

  it("ignores an archived agent when naming the owner", () => {
    const [row] = rows(
      [task({ threadId: "thread-a" as never })],
      [agent([], { archivedAt: "2026-10-01T00:00:00Z" })],
    );
    expect(row?.ownerLabel).toBe("A thread");
  });
});

describe("buildScheduleRows: goals", () => {
  it("folds a goal's own task into one row", () => {
    const goalTask = task({ id: "agent-goal:g1" as never, threadId: "thread-a" as never });
    const result = rows([goalTask, task()], [agent([goal()])]);
    expect(result).toHaveLength(2);
    const row = result.find((entry) => entry.kind === "goal");
    expect(row).toMatchObject({
      title: "Weekly reels",
      doing: "Keep three reels ready each week.",
      ownerLabel: "Ava, goal",
      cadence: "Mon At 8:00 AM",
      stateLabel: "On",
      taskId: "agent-goal:g1",
      goalId: "g1",
      threadId: "thread-a",
      canPause: true,
      canRunNow: true,
      canOpen: true,
    });
  });

  it("pauses and resumes through the goal, and says when the server paused it", () => {
    const paused = rows(
      [task({ id: "agent-goal:g1" as never, enabled: false, nextRunAt: null })],
      [agent([goal({ status: "paused", pausedReason: "unreviewed_limit" })])],
    )[0];
    expect(paused).toMatchObject({
      stateLabel: "Paused: Check-Ins Waiting",
      canPause: false,
      canResume: true,
      nextRun: "Not while it is paused",
    });
  });

  it("shows a done goal read-only with the reason", () => {
    const [row] = rows(
      [task({ id: "agent-goal:g1" as never })],
      [agent([goal({ status: "done" })])],
    );
    expect(row).toMatchObject({
      stateLabel: "Done",
      canPause: false,
      canResume: false,
      canRunNow: false,
    });
    expect(row?.readOnlyReason).toContain("done");
  });

  it("shows a goal whose task is missing, without Run Now", () => {
    const [row] = rows([], [agent([goal()])]);
    expect(row).toMatchObject({
      canRunNow: false,
      nextRun: "Not available",
      lastResult: "Not available",
    });
  });

  it("keeps a goal's task with no known goal read-only, so it is not paused behind the goal's back", () => {
    const [row] = rows([task({ id: "agent-goal:lost" as never })], []);
    expect(row).toMatchObject({ canPause: false, canResume: false, canRunNow: true });
    expect(row?.readOnlyReason).toContain("cannot be paused here");
  });

  it("does not offer actions on an archived agent's goal", () => {
    const [row] = rows(
      [task({ id: "agent-goal:g1" as never })],
      [agent([goal()], { archivedAt: "2026-10-01T00:00:00Z" })],
    );
    expect(row).toMatchObject({ canPause: false, canRunNow: false });
    expect(row?.readOnlyReason).toBe("This agent is archived.");
  });
});

describe("order and summary", () => {
  it("lists running first, then soonest, then paused, then done", () => {
    const list = rows(
      [
        task({ id: "later" as never, title: "Later", nextRunAt: "2026-10-09T09:00:00Z" }),
        task({ id: "soon" as never, title: "Soon", nextRunAt: "2026-10-06T16:00:00Z" }),
        task({ id: "off" as never, title: "Off", enabled: false, nextRunAt: null }),
        task({ id: "busy" as never, title: "Busy", lastRunStatus: "running" }),
      ],
      [],
    );
    expect(list.map((row) => row.title)).toEqual(["Busy", "Soon", "Later", "Off"]);
  });

  it("summarises the list", () => {
    expect(scheduleSummary([])).toBe("Nothing Scheduled");
    const list = rows([task(), task({ id: "t2" as never, enabled: false, nextRunAt: null })]);
    expect(scheduleSummary(list)).toBe("1 On, 1 Paused");
  });
});
