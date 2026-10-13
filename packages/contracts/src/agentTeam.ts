import * as Schema from "effect/Schema";

import { MessageId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorMcpClientRequestId, OrchestratorMcpPrompt } from "./orchestratorMcp.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Agents working with each other by name. Like the goal tools, these are scoped by the calling
 * thread: the sender is always the agent that owns it, never an argument.
 */

/** Longest back-and-forth chain of agent messages the server will extend. */
export const AGENT_MESSAGE_MAX_HOPS = 3;
/** Longest reply text delivered back to the asker; the rest stays readable with t3_thread_read. */
export const AGENT_REPLY_MAX_CHARS = 8_000;
/** Ids of automatic replies start with this followed by the id of the message being answered. */
export const AGENT_REPLY_MESSAGE_ID_PREFIX = "agent-reply:";
export const AGENT_LIST_ROLE_MAX = 160;
export const AGENT_LIST_GOAL_MAX = 200;

/**
 * What an agent is doing, from its own conversation. not_started means it has no conversation
 * yet; its first assignment prepares one automatically.
 */
export const AgentTeamStatus = Schema.Literals([
  "idle",
  "working",
  "needs_input",
  "failed",
  "not_started",
]);
export type AgentTeamStatus = typeof AgentTeamStatus.Type;

export const AgentTeamMember = Schema.Struct({
  agentId: Schema.String,
  name: Schema.String,
  /** The agent's description, else the first line of its instructions; bounded, never the full text. */
  role: Schema.String.check(Schema.isMaxLength(AGENT_LIST_ROLE_MAX)),
  status: AgentTeamStatus,
  /** The agent's conversation; null until it has one. */
  threadId: Schema.NullOr(ThreadId),
  /** Title of its first active standing goal, if any. */
  currentGoal: Schema.NullOr(Schema.String.check(Schema.isMaxLength(AGENT_LIST_GOAL_MAX))),
  /** True for the agent that owns the calling thread. It cannot message itself. */
  isYou: Schema.Boolean,
});
export type AgentTeamMember = typeof AgentTeamMember.Type;

export const AgentTeamListResult = Schema.Struct({ agents: Schema.Array(AgentTeamMember) });
export type AgentTeamListResult = typeof AgentTeamListResult.Type;

export const AgentTeamSendInput = Schema.Struct({
  agent: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description:
      "The agent's name (matched ignoring case) or id, as listed by agent_list. An unknown or ambiguous name is refused with the closest matches.",
  }),
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(
    Schema.Literals(["auto", "queue", "steer"]).annotate({
      description:
        "auto (default) starts an idle agent and queues behind or steers a working one; queue forces a separate follow-up turn; steer adds to its current turn.",
    }),
  ),
  awaitReply: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Default true: when the agent's run on this message finishes, its final message comes back to you automatically as a message from that agent, and you are woken to continue. Set false for a message that needs no answer.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type AgentTeamSendInput = typeof AgentTeamSendInput.Type;

export const AgentTeamSendResult = Schema.Struct({
  agentId: Schema.String,
  agentName: Schema.String,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  /** How many agent-to-agent messages deep the receiving run now is, out of the allowed maximum. */
  hops: Schema.Number,
  /** True when the agent's answer will be delivered to this conversation on its own. */
  replyExpected: Schema.optional(Schema.Boolean),
});
export type AgentTeamSendResult = typeof AgentTeamSendResult.Type;

/** Creates a persistent teammate and gives it its first assignment, without copying history. */
export const AgentTeamCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.String.check(Schema.isMaxLength(240)),
  instructions: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  message: OrchestratorMcpPrompt,
  modelSelection: Schema.optional(ModelSelection),
  clientRequestId: OrchestratorMcpClientRequestId.annotate({
    description: "A stable key for this creation and first assignment. Reuse it on retries.",
  }),
});
export type AgentTeamCreateInput = typeof AgentTeamCreateInput.Type;
export const AgentTeamCreateResult = Schema.Struct({
  ...AgentTeamSendResult.fields,
  created: Schema.Boolean,
});
export type AgentTeamCreateResult = typeof AgentTeamCreateResult.Type;
