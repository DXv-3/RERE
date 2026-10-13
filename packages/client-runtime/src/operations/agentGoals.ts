import {
  AGENT_GOAL_MAX_COUNT,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type AgentGoalAutonomy,
  type AgentGoalError,
  type AgentGoalStatus,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
  type WorkbenchAgentGoal,
} from "@t3tools/contracts";

/**
 * The server pauses a goal once this many of its check-ins wait for review. Mirrors
 * `UNREVIEWED_CHECKIN_LIMIT` in `apps/server/src/agents/AgentGoals.ts`; the contracts do not carry it.
 */
const UNREVIEWED_CHECKIN_LIMIT = 5;

export const AGENT_GOAL_AUTONOMY: ReadonlyArray<{
  readonly value: AgentGoalAutonomy;
  readonly label: string;
  readonly help: string;
}> = [
  {
    value: "propose",
    label: "Propose Only",
    help: "Plans the work and reports back. Changes nothing without you.",
  },
  {
    value: "act_and_report",
    label: "Act And Report",
    help: "Does the work, then tells you what it did.",
  },
  {
    value: "act_freely",
    label: "Act Freely",
    help: "Does whatever the goal needs, then reports.",
  },
];

const AGENT_GOAL_STATUS_LABEL: Record<AgentGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
};

export function autonomyLabel(autonomy: AgentGoalAutonomy): string {
  return AGENT_GOAL_AUTONOMY.find((option) => option.value === autonomy)?.label ?? autonomy;
}

/** "Paused: 5 Check-Ins Waiting For Review" when the server stopped it, else just the status. */
export function goalStatusLabel(goal: Pick<WorkbenchAgentGoal, "status" | "pausedReason">): string {
  return goal.status === "paused" && goal.pausedReason === "unreviewed_limit"
    ? `Paused: ${UNREVIEWED_CHECKIN_LIMIT} Check-Ins Waiting For Review`
    : AGENT_GOAL_STATUS_LABEL[goal.status];
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "13:05" as "1:05 PM". Anything that is not HH:MM is returned as typed. */
export function formatTimeOfDay(timeOfDay: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay);
  if (!match) return timeOfDay;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${suffix}`;
}

function describeInterval(everyMs: number): string {
  const minutes = everyMs / 60_000;
  if (!Number.isInteger(minutes)) return `Every ${Math.round(everyMs / 1000)} Seconds`;
  if (minutes === 1) return "Every Minute";
  if (minutes < 60) return `Every ${minutes} Minutes`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "Every Day" : `Every ${days} Days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "Every Hour" : `Every ${hours} Hours`;
  }
  return `Every ${minutes} Minutes`;
}

/** A schedule in plain words: "Weekdays At 9:00 AM", "Mon, Wed At 6:30 PM", "Every 2 Hours". */
export function describeSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") return describeInterval(schedule.everyMs);
  const days = [...new Set(schedule.weekdays ?? [])].sort((a, b) => a - b);
  const time = formatTimeOfDay(schedule.timeOfDay);
  if (days.length === 0 || days.length === 7) return `Every Day At ${time}`;
  if (days.join() === "1,2,3,4,5") return `Weekdays At ${time}`;
  if (days.join() === "0,6") return `Weekends At ${time}`;
  return `${days.map((day) => WEEKDAY_NAMES[day]).join(", ")} At ${time}`;
}

export type GoalFields =
  | {
      readonly ok: true;
      readonly fields: {
        readonly title: string;
        readonly outcome: string;
        readonly schedule: ScheduledTaskUpsertSchedule;
        readonly autonomy: AgentGoalAutonomy;
      };
    }
  | { readonly ok: false; readonly message: string };

/**
 * What the server accepts, checked up front so a form can say what is wrong in plain words.
 * Each client builds `schedule` from its own form; null means its schedule inputs were unusable.
 */
export function checkGoalFields(input: {
  readonly title: string;
  readonly outcome: string;
  readonly schedule: ScheduledTaskUpsertSchedule | null;
  readonly autonomy: AgentGoalAutonomy;
}): GoalFields {
  const title = input.title.trim();
  const outcome = input.outcome.trim();
  if (title === "") return { ok: false, message: "Give the goal a short title." };
  if (outcome === "") return { ok: false, message: "Describe what done looks like." };
  const { schedule, autonomy } = input;
  if (schedule === null)
    return {
      ok: false,
      message:
        "Check the schedule: choose a time and at least one day, or an interval of at least one minute.",
    };
  if (schedule.type === "interval") {
    if (
      !Number.isSafeInteger(schedule.everyMs) ||
      schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS
    )
      return { ok: false, message: "Enter an interval of at least one minute." };
    return { ok: true, fields: { title, outcome, schedule, autonomy } };
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(schedule.timeOfDay))
    return { ok: false, message: "Choose a time of day." };
  return { ok: true, fields: { title, outcome, schedule, autonomy } };
}

/** The sentence shown for each way a goal or check-in call can fail. */
const GOAL_ERROR_MESSAGE: Record<AgentGoalError["reason"], string> = {
  agent_not_found: "This agent could not be found. Refresh and try again.",
  agent_archived: "This agent is archived. Restore it before changing its goals.",
  no_primary_thread: "Start a conversation with this agent before giving it a goal.",
  goal_not_found: "This goal no longer exists. It may have been deleted on another device.",
  goal_limit: `An agent can hold up to ${AGENT_GOAL_MAX_COUNT} goals.`,
  owner_only_resume: "Only you can resume a goal.",
  checkin_not_found: "This check-in no longer exists.",
  already_reviewed: "This check-in was already reviewed.",
  invalid_cursor: "The list could not be loaded. Try again.",
  note_required: "Write a note first. It is sent to the agent as its next instruction.",
  conflict: "This agent changed on another device. Try again.",
  thread_unavailable:
    "The agent's conversation is not available, so nothing was sent. Open the conversation and try again.",
  task_failed: "The schedule could not be updated. Try again.",
  storage: "The server could not save this. Try again.",
};

const GOAL_FALLBACK_ERROR = "Could not reach the agent workspace. Try again.";

/** The `reason` of an `AgentGoalError`, or null for any other failure. */
export function goalErrorReason(error: unknown): AgentGoalError["reason"] | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, reason } = error as { _tag?: unknown; reason?: unknown };
  return _tag === "AgentGoalError" && typeof reason === "string" && reason in GOAL_ERROR_MESSAGE
    ? (reason as AgentGoalError["reason"])
    : null;
}

export function goalReasonMessage(reason: AgentGoalError["reason"]): string {
  return GOAL_ERROR_MESSAGE[reason];
}

export function goalErrorMessage(error: unknown): string {
  const reason = goalErrorReason(error);
  return reason === null ? GOAL_FALLBACK_ERROR : GOAL_ERROR_MESSAGE[reason];
}
