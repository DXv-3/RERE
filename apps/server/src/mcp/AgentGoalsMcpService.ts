import {
  OrchestratorMcpFailure,
  type AgentGoalError,
  type AgentGoalMcpListResult,
  type AgentGoalMcpReportCheckInInput,
  type AgentGoalMcpReportCheckInResult,
  type AgentGoalMcpResult,
  type AgentGoalMcpSetInput,
  type AgentGoalMcpSetStatusInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentGoals from "../agents/AgentGoals.ts";
import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { holdsOrchestration, type McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * Goal tools for agents. The goal rules live in `AgentGoals`; this service only works out
 * which agent the calling thread belongs to and shapes the answer. The agent always comes from
 * the thread identity of the MCP credential, never from a tool argument, so a call can only
 * read and change the caller's own goals.
 */
export class AgentGoalsMcpService extends Context.Service<
  AgentGoalsMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentGoalMcpListResult, OrchestratorMcpFailure>;
    readonly set: (
      scope: McpInvocationScope,
      input: AgentGoalMcpSetInput,
    ) => Effect.Effect<AgentGoalMcpResult, OrchestratorMcpFailure>;
    readonly setStatus: (
      scope: McpInvocationScope,
      input: AgentGoalMcpSetStatusInput,
    ) => Effect.Effect<AgentGoalMcpResult, OrchestratorMcpFailure>;
    readonly reportCheckIn: (
      scope: McpInvocationScope,
      input: AgentGoalMcpReportCheckInInput,
    ) => Effect.Effect<AgentGoalMcpReportCheckInResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/AgentGoalsMcpService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const goalFailure = (error: AgentGoalError) =>
  error.reason === "owner_only_resume"
    ? failure("invalid_request", "Only the owner can resume a goal.")
    : error.reason === "storage" || error.reason === "task_failed"
      ? failure("orchestration_error", error.message)
      : failure("invalid_request", error.message);

const make = Effect.gen(function* () {
  const goals = yield* AgentGoals.AgentGoals;
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  // Goals belong to the calling agent, so they stay available when the owner switched Other
  // Conversations off: that switch is about reaching beyond the agent's own thread.
  const requireCapability = (scope: McpInvocationScope) =>
    holdsOrchestration(scope)
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  /** The agent the calling thread belongs to: its primary thread, else one of its threads. */
  const ownAgent = Effect.fn("AgentGoalsMcpService.ownAgent")(function* (
    scope: McpInvocationScope,
  ) {
    const all = yield* agents.list.pipe(
      Effect.mapError(() => failure("orchestration_error", "Could not read agents.")),
    );
    const own =
      all.find((agent) => agent.primaryThreadId === scope.threadId) ??
      all.find((agent) => agent.threadIds?.includes(scope.threadId));
    if (own === undefined) {
      return yield* failure("invalid_request", "This thread does not belong to an agent.");
    }
    return own;
  });

  const callerRunId = (scope: McpInvocationScope) =>
    threads.getThreadRecords(scope.threadId, ["runs"]).pipe(
      Effect.map(
        ({ runs }) =>
          runs
            .filter(ThreadManagementService.isActiveRun)
            .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.id ?? null,
      ),
      Effect.orElseSucceed(() => null),
    );

  return AgentGoalsMcpService.of({
    list: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* ownAgent(scope);
        return { agentId: agent.profile.id, goals: agent.goals ?? [] };
      }),
    set: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* ownAgent(scope);
        // Editing a goal without naming an autonomy must not quietly reset it.
        const autonomy =
          input.autonomy ??
          (input.goalId === undefined
            ? "propose"
            : (agent.goals?.find((goal) => goal.id === input.goalId)?.autonomy ?? "propose"));
        const result = yield* goals
          .upsertGoal({
            agentId: agent.profile.id,
            ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
            title: input.title,
            outcome: input.outcome,
            schedule: input.schedule,
            autonomy,
          })
          .pipe(Effect.mapError(goalFailure));
        return { agentId: agent.profile.id, goal: result.goal };
      }),
    setStatus: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* ownAgent(scope);
        const result = yield* goals
          .setStatus(
            { agentId: agent.profile.id, goalId: input.goalId, status: input.status },
            { byAgent: true },
          )
          .pipe(Effect.mapError(goalFailure));
        return { agentId: agent.profile.id, goal: result.goal };
      }),
    reportCheckIn: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* ownAgent(scope);
        // Another agent's goal answers exactly like a missing one, so ids do not leak.
        if (!agent.goals?.some((goal) => goal.id === input.goalId)) {
          return yield* failure("invalid_request", "Agent goals: goal not found.");
        }
        const runId = yield* callerRunId(scope);
        const filed = yield* goals
          .fileCheckIn({
            goalId: input.goalId,
            threadId: scope.threadId,
            runId,
            summary: input.summary,
            needsFromOwner: input.needsFromOwner ?? null,
            done: input.done === true,
          })
          .pipe(Effect.mapError(goalFailure));
        return {
          checkInId: filed.checkIn.id,
          goalId: filed.goal.id,
          goalStatus: filed.goal.status,
        };
      }),
  });
});

export const layer: Layer.Layer<
  AgentGoalsMcpService,
  never,
  | AgentGoals.AgentGoals
  | AgentWorkspace.AgentWorkspace
  | ThreadManagementService.ThreadManagementService
> = Layer.effect(AgentGoalsMcpService, make);
