import * as Schema from "effect/Schema";

import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorMcpSchedule } from "./orchestratorMcp.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";
import {
  AgentGoalAutonomy,
  AgentGoalOutcome,
  AgentGoalStatus,
  AgentGoalTitle,
  WorkbenchAgentGoal,
  WorkspaceAgent,
} from "./workbenchAgents.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = text(240).check(Schema.isMinLength(1));

export const AgentCheckInStatus = Schema.Literals([
  "pending",
  "approved",
  "redirected",
  "dismissed",
]);
export type AgentCheckInStatus = typeof AgentCheckInStatus.Type;
/** `agent` is the agent's own report; `fallback` is the server quoting the turn's last reply. */
export const AgentCheckInSource = Schema.Literals(["agent", "fallback"]);
export type AgentCheckInSource = typeof AgentCheckInSource.Type;
export const AGENT_CHECKIN_SUMMARY_MAX = 8_000;
export const AGENT_CHECKIN_NOTE_MAX = 4_000;

export const AgentCheckIn = Schema.Struct({
  id,
  agentId: id,
  goalId: id,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  createdAt: text(80),
  summary: text(AGENT_CHECKIN_SUMMARY_MAX),
  needsFromOwner: Schema.NullOr(text(AGENT_CHECKIN_NOTE_MAX)),
  source: AgentCheckInSource,
  status: AgentCheckInStatus,
  ownerNote: Schema.NullOr(text(AGENT_CHECKIN_NOTE_MAX)),
  reviewedAt: Schema.NullOr(text(80)),
});
export type AgentCheckIn = typeof AgentCheckIn.Type;

export const AgentGoalUpsertInput = Schema.Struct({
  agentId: id,
  /** Omit to create a goal; pass an existing id to edit it. */
  goalId: Schema.optional(id),
  title: AgentGoalTitle,
  outcome: AgentGoalOutcome,
  schedule: ScheduledTaskUpsertSchedule,
  autonomy: AgentGoalAutonomy,
});
export type AgentGoalUpsertInput = typeof AgentGoalUpsertInput.Type;

export const AgentGoalSetStatusInput = Schema.Struct({
  agentId: id,
  goalId: id,
  status: AgentGoalStatus,
});
export type AgentGoalSetStatusInput = typeof AgentGoalSetStatusInput.Type;

export const AgentGoalDeleteInput = Schema.Struct({ agentId: id, goalId: id });
export type AgentGoalDeleteInput = typeof AgentGoalDeleteInput.Type;

/** The saved agent carries the new revision a client needs for its next `agents.save`. */
export const AgentGoalResult = Schema.Struct({ agent: WorkspaceAgent, goal: WorkbenchAgentGoal });
export type AgentGoalResult = typeof AgentGoalResult.Type;
export const AgentGoalDeleteResult = Schema.Struct({ agent: WorkspaceAgent });
export type AgentGoalDeleteResult = typeof AgentGoalDeleteResult.Type;

const AGENT_CHECKIN_PAGE_SIZE_MAX = 100;
export const AgentCheckInFilter = Schema.Struct({
  agentId: Schema.optional(id),
  goalId: Schema.optional(id),
  status: Schema.optional(AgentCheckInStatus),
});
export type AgentCheckInFilter = typeof AgentCheckInFilter.Type;

export const AgentCheckInListInput = Schema.Struct({
  ...AgentCheckInFilter.fields,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: AGENT_CHECKIN_PAGE_SIZE_MAX })),
  ),
  /** The `nextCursor` of the previous page. */
  cursor: Schema.optional(text(400)),
});
export type AgentCheckInListInput = typeof AgentCheckInListInput.Type;

/** Newest first. `nextCursor` is null on the last page. */
export const AgentCheckInPage = Schema.Struct({
  checkIns: Schema.Array(AgentCheckIn),
  nextCursor: Schema.NullOr(text(400)),
});
export type AgentCheckInPage = typeof AgentCheckInPage.Type;

export const AgentCheckInReviewInput = Schema.Struct({
  id,
  action: Schema.Literals(["approve", "redirect", "dismiss"]),
  /** Required for `redirect`: it is sent to the agent as the next instruction. */
  note: Schema.optional(text(AGENT_CHECKIN_NOTE_MAX)),
});
export type AgentCheckInReviewInput = typeof AgentCheckInReviewInput.Type;

export class AgentGoalError extends Schema.TaggedError<AgentGoalError>()("AgentGoalError", {
  reason: Schema.Literals([
    "agent_not_found",
    "agent_archived",
    "no_primary_thread",
    "goal_not_found",
    "goal_limit",
    "checkin_not_found",
    "already_reviewed",
    "owner_only_resume",
    "invalid_cursor",
    "note_required",
    "conflict",
    "thread_unavailable",
    "task_failed",
    "storage",
  ]),
}) {
  override get message() {
    return `Agent goals: ${this.reason.replaceAll("_", " ")}.`;
  }
}

const GoalIdParam = id.annotate({ description: "The goal id from goal_list." });
// The MCP goal tools take no agent id: the server resolves the calling thread's own agent, so
// an agent can only ever read and change its own goals.
export const AgentGoalMcpListResult = Schema.Struct({
  agentId: id,
  goals: Schema.Array(WorkbenchAgentGoal),
});
export type AgentGoalMcpListResult = typeof AgentGoalMcpListResult.Type;

export const AgentGoalMcpSetInput = Schema.Struct({
  goalId: Schema.optional(
    GoalIdParam.annotate({
      description: "Pass to edit an existing goal; leave out to create one.",
    }),
  ),
  title: AgentGoalTitle.annotate({ description: "Short name, up to 200 characters." }),
  outcome: AgentGoalOutcome.annotate({
    description: "What done looks like for this goal, in plain words.",
  }),
  schedule: OrchestratorMcpSchedule,
  autonomy: Schema.optional(
    AgentGoalAutonomy.annotate({
      description:
        "propose (default): plan and report, change nothing. act_and_report: do the work, then report. act_freely: do whatever the goal needs, then report.",
    }),
  ),
});
export type AgentGoalMcpSetInput = typeof AgentGoalMcpSetInput.Type;

export const AgentGoalMcpSetStatusInput = Schema.Struct({
  goalId: GoalIdParam,
  status: AgentGoalStatus.annotate({
    description:
      "paused stops runs until the owner resumes the goal, done ends the goal. Only the owner can set a paused or done goal back to active; active on an already active goal changes nothing.",
  }),
});
export type AgentGoalMcpSetStatusInput = typeof AgentGoalMcpSetStatusInput.Type;

export const AgentGoalMcpResult = Schema.Struct({ agentId: id, goal: WorkbenchAgentGoal });
export type AgentGoalMcpResult = typeof AgentGoalMcpResult.Type;

export const AgentGoalMcpReportCheckInInput = Schema.Struct({
  goalId: GoalIdParam,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)).annotate({
    description: "What you did and what you found this turn, in a few plain sentences.",
  }),
  needsFromOwner: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)).annotate({
      description: "A decision or input you need from the owner. Leave out if you need nothing.",
    }),
  ),
  done: Schema.optional(
    Schema.Boolean.annotate({
      description: "True only when the goal's outcome is fully achieved.",
    }),
  ),
});
export type AgentGoalMcpReportCheckInInput = typeof AgentGoalMcpReportCheckInInput.Type;
export const AgentGoalMcpReportCheckInResult = Schema.Struct({
  checkInId: id,
  goalId: id,
  goalStatus: AgentGoalStatus,
});
export type AgentGoalMcpReportCheckInResult = typeof AgentGoalMcpReportCheckInResult.Type;
