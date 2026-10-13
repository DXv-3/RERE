import * as Schema from "effect/Schema";
import { ScheduledTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ScheduledTaskSchedule } from "./scheduledTask.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = text(240).check(Schema.isMinLength(1));
export const AgentAvatar = Schema.Struct({
  imageRef: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)))),
  kind: Schema.Literals(["bot", "initials", "icon", "image"]),
  shape: Schema.Literals([
    "circle",
    "squircle",
    "cloud",
    "hex",
    "teardrop",
    "wedge",
    "blob",
    "tablet",
    "pebble",
  ]),
  color: text(32),
  icon: text(40),
  image: Schema.NullOr(
    text(700_000).check(Schema.isPattern(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)),
  ),
});
export type AgentAvatar = typeof AgentAvatar.Type;
/**
 * The groups of built-in tools an owner can switch off for one agent. They are the MCP
 * capabilities of the server's built-in tool server, one switch each.
 */
export const AGENT_TOOL_GROUPS = [
  "preview",
  "device",
  "orchestration",
  "worktree",
  "pull-requests",
  "media",
  "campaigns",
] as const;
export const AgentToolGroup = Schema.Literals(AGENT_TOOL_GROUPS);
export type AgentToolGroup = typeof AgentToolGroup.Type;
/** What the owner sees for each group; the server's refusal message uses the same words. */
export const AGENT_TOOL_GROUP_LABELS: Readonly<Record<AgentToolGroup, string>> = {
  preview: "Browser",
  device: "Devices",
  orchestration: "Other Conversations",
  worktree: "Worktrees",
  "pull-requests": "Pull Requests",
  media: "Media Review",
  campaigns: "Campaigns",
};
export const agentToolGroupSwitchedOffMessage = (group: string): string =>
  `This agent's ${AGENT_TOOL_GROUP_LABELS[group as AgentToolGroup] ?? group} access is switched off.`;
export const WorkbenchAgentProfile = Schema.Struct({
  id,
  name: text(80).check(Schema.isMinLength(1)),
  description: text(240),
  instructions: text(16_000),
  color: text(32),
  pinned: Schema.Boolean,
  projectKey: text(1_000),
  runtimeMode: Schema.Union([RuntimeMode, Schema.Literal("inherit")]),
  modelSelection: Schema.NullOr(ModelSelection),
  avatar: Schema.optional(AgentAvatar),
  /**
   * Tool groups switched off for this agent. A deny-list, so a group added later is on until an
   * owner switches it off. Absent or empty means everything is allowed.
   */
  blockedToolGroups: Schema.optional(
    Schema.Array(AgentToolGroup).check(Schema.isMaxLength(AGENT_TOOL_GROUPS.length)),
  ),
});
export type WorkbenchAgentProfile = typeof WorkbenchAgentProfile.Type;
export const AgentArchiveMessage = Schema.Struct({
  id,
  role: Schema.Literals(["user", "assistant"]),
  text: text(100_000),
  timestampMs: Schema.NullOr(Schema.Finite),
});
export const AgentArchive = Schema.Struct({
  id,
  sourceId: id,
  name: text(80),
  importedAt: text(80),
  exportedAt: text(80),
  sourceSettings: Schema.Record(
    Schema.String,
    Schema.Union([text(200), Schema.Finite, Schema.Boolean, Schema.Null]),
  ),
  messages: Schema.Array(AgentArchiveMessage).check(Schema.isMaxLength(5_000)),
});
export type AgentArchive = typeof AgentArchive.Type;
export const AgentRecovery = Schema.Struct({
  disposition: Schema.Literals(["continue_in_source", "ready", "completed", "blocked"]),
  summary: text(16_000),
  blockers: Schema.Array(text(1_000)).check(Schema.isMaxLength(100)),
  verifiedAt: Schema.NullOr(text(80)),
  evidence: Schema.Array(text(2_000)).check(Schema.isMaxLength(100)),
});
export const AgentMemory = Schema.Struct({
  id,
  text: text(8_000),
  origin: Schema.Literals(["user", "inferred"]),
  sources: Schema.Array(text(2_000)).check(Schema.isMaxLength(30)),
});
/**
 * How much an agent may do on a goal turn. Enforced by the turn prompt only: the
 * goal runs under the agent's own runtime mode, which is the real permission boundary.
 */
export const AgentGoalAutonomy = Schema.Literals(["propose", "act_and_report", "act_freely"]);
export type AgentGoalAutonomy = typeof AgentGoalAutonomy.Type;
export const AgentGoalStatus = Schema.Literals(["active", "paused", "done"]);
export type AgentGoalStatus = typeof AgentGoalStatus.Type;
export const AgentGoalPausedReason = Schema.Literals(["owner", "unreviewed_limit"]);
export type AgentGoalPausedReason = typeof AgentGoalPausedReason.Type;
export const AGENT_GOAL_MAX_COUNT = 20;
export const AgentGoalTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const AgentGoalOutcome = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
/**
 * A standing goal: the agent gets a turn on `schedule` and must end it with a check-in.
 * Server-local state; the scheduled task that fires it is derived from the goal id.
 */
export const WorkbenchAgentGoal = Schema.Struct({
  id,
  title: AgentGoalTitle,
  outcome: AgentGoalOutcome,
  schedule: ScheduledTaskSchedule,
  autonomy: AgentGoalAutonomy,
  status: AgentGoalStatus,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  pausedReason: Schema.optional(AgentGoalPausedReason),
  createdAt: text(80),
  updatedAt: text(80),
});
export type WorkbenchAgentGoal = typeof WorkbenchAgentGoal.Type;

const AGENT_GOAL_TASK_ID_PREFIX = "agent-goal:";
/** The scheduled task that fires a goal. Deriving the id keeps task and goal in step with no lookup. */
export const agentGoalTaskId = (goalId: string) =>
  ScheduledTaskId.make(`${AGENT_GOAL_TASK_ID_PREFIX}${goalId}`);
/** The goal a scheduled task fires, or null when the task is not a goal task. */
export const goalIdFromTaskId = (taskId: string): string | null =>
  taskId.startsWith(AGENT_GOAL_TASK_ID_PREFIX) && taskId.length > AGENT_GOAL_TASK_ID_PREFIX.length
    ? taskId.slice(AGENT_GOAL_TASK_ID_PREFIX.length)
    : null;

export const WorkspaceAgent = Schema.Struct({
  profile: WorkbenchAgentProfile,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  archive: Schema.NullOr(AgentArchive),
  recovery: AgentRecovery,
  memories: Schema.Array(AgentMemory).check(Schema.isMaxLength(100)),
  primaryThreadId: Schema.NullOr(id),
  threadIds: Schema.optional(Schema.Array(id).check(Schema.isMaxLength(1000))),
  routineOwnershipVerified: Schema.optional(Schema.Boolean),
  goals: Schema.optional(
    Schema.Array(WorkbenchAgentGoal).check(Schema.isMaxLength(AGENT_GOAL_MAX_COUNT)),
  ),
  archivedAt: Schema.optional(Schema.NullOr(text(80))),
  updatedAt: text(80),
});
export type WorkspaceAgent = typeof WorkspaceAgent.Type;
export const AgentList = Schema.Array(WorkspaceAgent);
export const AgentSaveInput = Schema.Struct({
  agent: WorkspaceAgent,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const AgentRecoveryDraft = Schema.Struct({
  summary: text(16000),
  blockers: Schema.Array(text(1000)).check(Schema.isMaxLength(100)),
  evidence: Schema.Array(text(2000)).check(Schema.isMaxLength(100)),
});
export const AgentImportInput = Schema.Struct({
  receiptId: id,
  agents: Schema.Array(
    Schema.Struct({
      profile: WorkbenchAgentProfile,
      archive: Schema.NullOr(AgentArchive),
      recoveryDraft: Schema.optional(AgentRecoveryDraft),
      threadIds: Schema.optional(Schema.Array(id).check(Schema.isMaxLength(1000))),
    }),
  ).check(Schema.isMaxLength(250)),
});
export const AgentImportReceipt = Schema.Struct({
  receiptId: id,
  added: Schema.Number,
  enriched: Schema.Number,
  importedAt: text(80),
});
export const AgentReadInput = Schema.Struct({ id });
export const AgentContinuationInput = Schema.Struct({
  id,
  maxCharacters: Schema.Number.check(Schema.isBetween({ minimum: 2_000, maximum: 60_000 })),
});
export const AgentContinuation = Schema.Struct({
  agentId: id,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  context: Schema.String,
  includedMessages: Schema.Number,
  omittedMessages: Schema.Number,
  blockers: Schema.Array(Schema.String),
  ready: Schema.Boolean,
});
export type AgentContinuation = typeof AgentContinuation.Type;
export class AgentWorkspaceError extends Schema.TaggedError<AgentWorkspaceError>()(
  "AgentWorkspaceError",
  {
    reason: Schema.Literals([
      "storage",
      "not_found",
      "conflict",
      "invalid_import",
      "recovery_required",
    ]),
  },
) {
  override get message() {
    return `Agent workspace: ${this.reason.replaceAll("_", " ")}.`;
  }
}
