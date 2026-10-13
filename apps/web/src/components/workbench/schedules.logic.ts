import {
  agentGoalTaskId,
  goalIdFromTaskId,
  type ScheduledTask,
  type WorkbenchAgentGoal,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import { describeSchedule } from "@t3tools/client-runtime/operations/agent-goals";

/**
 * What the Schedules screen decides, with no React and no I/O: it folds the machine's scheduled
 * tasks and every agent's goals into one list of rows, says in plain words when each runs next and
 * last ran, and says which buttons each row may have. A goal runs through a scheduled task the
 * server keeps in step with it, so the two are merged into one row; pausing a goal goes through the
 * goal (so its status stays true), and everything else goes through the task.
 */

// Words for time

const DAY_MS = 86_400_000;

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function calendarDay(date: Date, timeZone: string | undefined): CalendarDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day") };
}

const dayNumber = (day: CalendarDay): number =>
  Math.round(Date.UTC(day.year, day.month - 1, day.day) / DAY_MS);

const clock = (date: Date, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);

const weekdayName = (date: Date, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);

const monthDay = (date: Date, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(date);

const plural = (count: number, unit: string): string => `${count} ${unit}${count === 1 ? "" : "s"}`;

/**
 * An instant in plain words, relative to `now`: "In 5 minutes", "Today at 3:30 PM", "Tomorrow at
 * 9:00 AM", "Monday at 9:00 AM", "Oct 12 at 9:00 AM"; and for the past "12 minutes ago",
 * "Yesterday at 9:00 AM". Returns null for something that is not a time.
 */
export function whenInWords(
  iso: string,
  now: Date,
  options: { readonly timeZone?: string } = {},
): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const { timeZone } = options;
  const diff = at.getTime() - now.getTime();
  const minutes = Math.round(Math.abs(diff) / 60_000);
  if (diff >= 0) {
    if (diff < 60_000) return "In under a minute";
    if (diff < 3_600_000) return `In ${plural(Math.ceil(diff / 60_000), "minute")}`;
  } else {
    if (-diff < 60_000) return "Just now";
    if (-diff < 3_600_000) return `${plural(minutes, "minute")} ago`;
  }
  const days = dayNumber(calendarDay(at, timeZone)) - dayNumber(calendarDay(now, timeZone));
  const time = clock(at, timeZone);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days === -1) return `Yesterday at ${time}`;
  if (Math.abs(days) <= 6) {
    return `${days > 0 ? "" : "Last "}${weekdayName(at, timeZone)} at ${time}`;
  }
  return `${monthDay(at, timeZone)} at ${time}`;
}

// Rows

export type ScheduleRowState = "on" | "running" | "paused" | "done";

const SCHEDULE_STATE_LABEL: Readonly<Record<ScheduleRowState, string>> = {
  on: "On",
  running: "Running Now",
  paused: "Paused",
  done: "Done",
};

export type ScheduleOwner =
  | { readonly kind: "agent"; readonly agentId: string; readonly name: string }
  | { readonly kind: "thread" }
  | { readonly kind: "none" };

export interface ScheduleRow {
  readonly key: string;
  readonly kind: "task" | "goal";
  readonly title: string;
  /** What it does, in one line. */
  readonly doing: string;
  readonly owner: ScheduleOwner;
  /** Who it belongs to, in words. */
  readonly ownerLabel: string;
  readonly cadence: string;
  readonly state: ScheduleRowState;
  readonly stateLabel: string;
  readonly nextRun: string;
  readonly lastRun: string;
  readonly lastResult: string;
  readonly lastResultFailed: boolean;
  /** The scheduled task that fires it, when there is one to run now. */
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly goalId: string | null;
  /** The conversation Open Thread goes to. */
  readonly threadId: string | null;
  /** Which buttons the row has. A missing one is explained by `readOnlyReason`. */
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRunNow: boolean;
  readonly canOpen: boolean;
  /** Why a row has no Pause or Resume, when it has none that it could. */
  readonly readOnlyReason: string | null;
}

const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

function lastResultOf(
  task: ScheduledTask | undefined,
  now: Date,
  options: { readonly timeZone?: string },
): { readonly text: string; readonly failed: boolean; readonly lastRun: string } {
  if (task === undefined) {
    return { text: "Not available", failed: false, lastRun: "Not available" };
  }
  const when = task.lastRunAt === null ? null : whenInWords(task.lastRunAt, now, options);
  switch (task.lastRunStatus) {
    case "never":
      return { text: "Has not run yet", failed: false, lastRun: "Has not run yet" };
    case "running":
      return { text: "Running now", failed: false, lastRun: when ?? "Running now" };
    case "succeeded":
      return { text: "Succeeded", failed: false, lastRun: when ?? "Unknown" };
    case "failed":
      return {
        text:
          task.lastRunError === null || task.lastRunError.trim() === ""
            ? "Failed"
            : `Failed: ${oneLine(task.lastRunError, 200)}`,
        failed: true,
        lastRun: when ?? "Unknown",
      };
  }
}

function nextRunOf(
  enabled: boolean,
  task: ScheduledTask | undefined,
  now: Date,
  options: { readonly timeZone?: string },
): string {
  if (!enabled) return "Not while it is paused";
  if (task === undefined) return "Not available";
  if (task.lastRunStatus === "running") return "After this run finishes";
  if (task.nextRunAt === null) return "Not scheduled";
  const words = whenInWords(task.nextRunAt, now, options);
  if (words === null) return "Not scheduled";
  // A time already past and still waiting is due, which "5 minutes ago" would misstate.
  return Date.parse(task.nextRunAt) < now.getTime() ? "Due now" : words;
}

/** The agent whose conversation a thread is, when it is one. */
function agentOfThread(
  agents: ReadonlyArray<WorkspaceAgent>,
  threadId: string | null,
): WorkspaceAgent | undefined {
  if (threadId === null) return undefined;
  return agents.find(
    (agent) =>
      !agent.archivedAt &&
      (agent.primaryThreadId === threadId || (agent.threadIds ?? []).includes(threadId)),
  );
}

function goalRow(
  agent: WorkspaceAgent,
  goal: WorkbenchAgentGoal,
  task: ScheduledTask | undefined,
  now: Date,
  options: { readonly timeZone?: string },
): ScheduleRow {
  const result = lastResultOf(task, now, options);
  const state: ScheduleRowState =
    goal.status === "done"
      ? "done"
      : goal.status === "paused"
        ? "paused"
        : task?.lastRunStatus === "running"
          ? "running"
          : "on";
  const taskId = task?.id ?? null;
  const archived = Boolean(agent.archivedAt);
  const threadId = agent.primaryThreadId;
  return {
    key: `goal:${agent.profile.id}:${goal.id}`,
    kind: "goal",
    title: goal.title,
    doing: oneLine(goal.outcome),
    owner: { kind: "agent", agentId: agent.profile.id, name: agent.profile.name },
    ownerLabel: `${agent.profile.name}, goal`,
    cadence: describeSchedule(goal.schedule),
    state,
    stateLabel:
      goal.status === "paused" && goal.pausedReason === "unreviewed_limit"
        ? "Paused: Check-Ins Waiting"
        : SCHEDULE_STATE_LABEL[state],
    nextRun: nextRunOf(goal.status === "active", task, now, options),
    lastRun: result.lastRun,
    lastResult: result.text,
    lastResultFailed: result.failed,
    taskId,
    agentId: agent.profile.id,
    goalId: goal.id,
    threadId,
    canPause: goal.status === "active" && !archived,
    canResume: goal.status === "paused" && !archived,
    // A done goal is not run again from here; reopening it is done on the agent.
    canRunNow: goal.status !== "done" && taskId !== null && !archived && state !== "running",
    canOpen: threadId !== null,
    readOnlyReason:
      goal.status === "done"
        ? "This goal is done. Reopen it from the agent's goals."
        : archived
          ? "This agent is archived."
          : null,
  };
}

function taskRow(
  task: ScheduledTask,
  agents: ReadonlyArray<WorkspaceAgent>,
  now: Date,
  options: { readonly timeZone?: string },
): ScheduleRow {
  const result = lastResultOf(task, now, options);
  const threadId = task.threadId;
  const agent = agentOfThread(agents, threadId);
  const owner: ScheduleOwner =
    agent !== undefined
      ? { kind: "agent", agentId: agent.profile.id, name: agent.profile.name }
      : threadId !== null
        ? { kind: "thread" }
        : { kind: "none" };
  const orphanGoal = goalIdFromTaskId(task.id) !== null;
  const state: ScheduleRowState = !task.enabled
    ? "paused"
    : task.lastRunStatus === "running"
      ? "running"
      : "on";
  return {
    key: `task:${task.id}`,
    kind: "task",
    title: task.title,
    doing: oneLine(task.prompt),
    owner,
    ownerLabel:
      agent !== undefined
        ? agent.profile.name
        : threadId !== null
          ? "A thread"
          : task.createdBy === "agent"
            ? "An agent"
            : "No thread",
    cadence: describeSchedule(task.schedule),
    state,
    stateLabel: SCHEDULE_STATE_LABEL[state],
    nextRun: nextRunOf(task.enabled, task, now, options),
    lastRun: result.lastRun,
    lastResult: result.text,
    lastResultFailed: result.failed,
    taskId: task.id,
    agentId: agent?.profile.id ?? null,
    goalId: null,
    threadId,
    // The task of a goal this list cannot find is shown and runnable, but never paused here: the
    // server would switch it back on the next time the goal changes.
    canPause: !orphanGoal && task.enabled,
    canResume: !orphanGoal && !task.enabled,
    canRunNow: state !== "running",
    canOpen: threadId !== null,
    readOnlyReason: orphanGoal
      ? "This runs an agent's goal that is not in the list above, so it cannot be paused here."
      : null,
  };
}

const STATE_ORDER: Readonly<Record<ScheduleRowState, number>> = {
  running: 0,
  on: 1,
  paused: 2,
  done: 3,
};

/**
 * One row for every goal and every scheduled task. A goal's own task is folded into the goal's row.
 * Running first, then what runs soonest, then paused, then done.
 */
export function buildScheduleRows(input: {
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly agents: ReadonlyArray<WorkspaceAgent>;
  readonly now: Date;
  readonly timeZone?: string;
}): ScheduleRow[] {
  const options = input.timeZone === undefined ? {} : { timeZone: input.timeZone };
  const taskById = new Map(input.tasks.map((task) => [task.id as string, task]));
  const folded = new Set<string>();
  const rows: Array<{ readonly row: ScheduleRow; readonly nextAt: number }> = [];
  for (const agent of input.agents) {
    for (const goal of agent.goals ?? []) {
      const taskId = goal.scheduledTaskId ?? agentGoalTaskId(goal.id);
      folded.add(taskId);
      const task = taskById.get(taskId);
      rows.push({
        row: goalRow(agent, goal, task, input.now, options),
        nextAt: task?.nextRunAt ? Date.parse(task.nextRunAt) : Number.POSITIVE_INFINITY,
      });
    }
  }
  for (const task of input.tasks) {
    if (folded.has(task.id)) continue;
    rows.push({
      row: taskRow(task, input.agents, input.now, options),
      nextAt: task.nextRunAt ? Date.parse(task.nextRunAt) : Number.POSITIVE_INFINITY,
    });
  }
  return rows
    .toSorted(
      (a, b) =>
        STATE_ORDER[a.row.state] - STATE_ORDER[b.row.state] ||
        (a.nextAt === b.nextAt ? 0 : a.nextAt < b.nextAt ? -1 : 1) ||
        a.row.title.localeCompare(b.row.title),
    )
    .map((entry) => entry.row);
}

export const SCHEDULE_EXAMPLE_REQUEST =
  "Every weekday at 9 AM, please check on my campaigns and tell me what needs my attention. Set it up as a scheduled task.";

export const SCHEDULE_EMPTY_HINT = "Ask an agent to do this every weekday at 9";

/** "3 On, 1 Paused" for the heading. */
export function scheduleSummary(rows: ReadonlyArray<ScheduleRow>): string {
  if (rows.length === 0) return "Nothing Scheduled";
  const count = (states: ReadonlyArray<ScheduleRowState>) =>
    rows.filter((row) => states.includes(row.state)).length;
  const on = count(["on", "running"]);
  const paused = count(["paused"]);
  const done = count(["done"]);
  return [
    on > 0 ? `${on} On` : null,
    paused > 0 ? `${paused} Paused` : null,
    done > 0 ? `${done} Done` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}
