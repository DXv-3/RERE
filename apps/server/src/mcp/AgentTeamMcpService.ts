import {
  AGENT_MESSAGE_MAX_HOPS,
  CommandId,
  ProjectId,
  OrchestratorMcpFailure,
  type AgentTeamListResult,
  type AgentTeamCreateInput,
  type AgentTeamCreateResult,
  type AgentTeamSendInput,
  type AgentTeamSendResult,
  ThreadId,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as AgentReplies from "../agents/AgentReplies.ts";
import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  agentCurrentGoal,
  agentRole,
  agentStatusFromShell,
  describeAgents,
  matchAgent,
} from "./agentTeamNames.ts";
import { capabilityDeniedMessage, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * Agents working with each other by name: who is on the team, and a message to one of them.
 *
 * Delivery is the same path `t3_thread_send` uses (`OrchestratorMcpService.sendToThread`), aimed
 * at the recipient's own conversation, so the message is recorded as sent by another agent with
 * the sender's thread, an idle agent starts, and a working one queues or is steered. The sender
 * always comes from the calling thread, never from an argument. The service methods take the
 * scope, so a client surface can call them too.
 */
export class AgentTeamMcpService extends Context.Service<
  AgentTeamMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentTeamListResult, OrchestratorMcpFailure>;
    readonly send: (
      scope: McpInvocationScope,
      input: AgentTeamSendInput,
    ) => Effect.Effect<AgentTeamSendResult, OrchestratorMcpFailure>;
    readonly create: (
      scope: McpInvocationScope,
      input: AgentTeamCreateInput,
    ) => Effect.Effect<AgentTeamCreateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/AgentTeamMcpService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const notGranted = "This MCP credential does not grant orchestration capabilities.";
const decodeProjectKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

const make = Effect.gen(function* () {
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const replies = yield* AgentReplies.AgentReplies;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const preparation = yield* makeKeyedSerialExecutor<string>();

  // Reaching other agents is what the Other Conversations switch is for, so it refuses here
  // with the same words as every other tool in that group.
  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", capabilityDeniedMessage(scope, "orchestration", notGranted)),
        );

  const listAgents = agents.list.pipe(
    Effect.mapError(() => failure("orchestration_error", "Could not read agents.")),
  );

  const ownerOf = (all: ReadonlyArray<WorkspaceAgent>, threadId: ThreadId) =>
    all.find((agent) => agent.primaryThreadId === threadId) ??
    all.find((agent) => agent.threadIds?.includes(threadId));

  // The same deterministic primary conversation that the clients open. Preparing it is inert;
  // only the subsequent send starts work, after the agent's identity has been bound to it.
  const ensureConversation = (scope: McpInvocationScope, target: WorkspaceAgent) =>
    preparation.withLock(
      target.profile.id,
      Effect.gen(function* () {
        const current = yield* agents
          .read(target.profile.id)
          .pipe(Effect.mapError(() => failure("orchestration_error", "Could not read the agent.")));
        if (current.archivedAt || current.recovery.disposition !== "ready")
          return yield* failure(
            "thread_not_sendable",
            "This agent must be recovered before it can work.",
          );
        if (current.primaryThreadId) return ThreadId.make(current.primaryThreadId);
        const caller = yield* threads
          .getThreadProjection(scope.threadId)
          .pipe(
            Effect.mapError(() =>
              failure("thread_not_found", "Could not read the calling conversation."),
            ),
          );
        let projectId: ProjectId;
        if (current.profile.projectKey) {
          const key = decodeProjectKey(current.profile.projectKey);
          if (Option.isNone(key) || key.value[0] !== scope.environmentId)
            return yield* failure(
              "invalid_request",
              "This agent's selected project is unavailable on this machine.",
            );
          projectId = ProjectId.make(key.value[1]);
          const project = yield* projects
            .getShell(projectId)
            .pipe(
              Effect.mapError(() =>
                failure("orchestration_error", "Could not read the agent's project."),
              ),
            );
          if (Option.isNone(project))
            return yield* failure(
              "invalid_request",
              "This agent's selected project is unavailable on this machine.",
            );
        } else {
          projectId = (yield* folders.ensureScratchProject.pipe(
            Effect.mapError(() =>
              failure("orchestration_error", "Could not prepare the agent's personal workspace."),
            ),
          )).projectId;
        }
        const threadId = ThreadId.make(`agent:${current.profile.id}`);
        yield* launcher
          .launch({
            commandId: CommandId.make(`agent-primary-create:${current.profile.id}`),
            threadId,
            projectId,
            title: current.profile.name,
            prepareOnly: true,
            modelSelection: current.profile.modelSelection ?? caller.thread.modelSelection,
            runtimeMode:
              current.profile.runtimeMode === "inherit"
                ? caller.thread.runtimeMode
                : current.profile.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "orchestration_error",
                "Could not prepare the agent's conversation. No task was submitted.",
              ),
            ),
          );
        yield* agents
          .save({
            agent: {
              ...current,
              primaryThreadId: threadId,
              threadIds: [...new Set([...(current.threadIds ?? []), threadId])],
            },
            expectedRevision: current.revision,
          })
          .pipe(
            Effect.mapError(() =>
              failure(
                "orchestration_error",
                "Could not bind the agent's conversation. No task was submitted.",
              ),
            ),
          );
        return threadId;
      }),
    );

  /**
   * How many agent-to-agent messages led into the run the thread is executing now: 0 when a
   * person or a schedule started it, else one more than the sender's own depth. Read from the
   * messages themselves (an agent-created message that names its sending thread), so there is
   * no counter to keep in step. Stops one past the cap, which also ends any cycle.
   *
   * An automatic reply is not a hop its sender chose to make: it carries the depth of the ask it
   * answers, recorded when the ask was sent. Counting the reply as a fresh message from the
   * answering agent would either lock the asker out after one answer or, if skipped, let two
   * agents hand work back and forth forever.
   */
  const hopsInto = (threadId: ThreadId): Effect.Effect<number> =>
    Effect.gen(function* () {
      let depth = 0;
      let floor = 0;
      let current = threadId;
      while (depth <= AGENT_MESSAGE_MAX_HOPS) {
        const records = yield* threads
          .getThreadRecords(current, ["runs", "messages"], { messageRoles: ["user"] })
          .pipe(Effect.orElseSucceed(() => null));
        if (records === null) return Math.max(depth, floor);
        const activeRun = records.runs
          .filter(ThreadManagementService.isActiveRun)
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        // Every user message of the executing run counts, so a steer cannot hide an agent's ask.
        const newestFirst = records.messages.toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
        );
        const considered =
          activeRun === undefined
            ? newestFirst.slice(0, 1)
            : newestFirst.filter((message) => message.runId === activeRun.id);
        const fromAgents = considered.filter(
          (message) => message.createdBy === "agent" && message.senderThreadId !== undefined,
        );
        for (const message of fromAgents) {
          if (!AgentReplies.isAgentReplyMessageId(message.id)) continue;
          const recorded = yield* replies.hopsOfReply(message.id);
          floor = Math.max(floor, depth + (recorded ?? 1));
        }
        const sender = fromAgents.find(
          (message) => !AgentReplies.isAgentReplyMessageId(message.id),
        )?.senderThreadId;
        if (sender === undefined) return Math.max(depth, floor);
        depth += 1;
        current = sender;
      }
      return Math.max(depth, floor);
    });

  const service: AgentTeamMcpService["Service"] = {
    create: (scope, input) =>
      preparation.withLock(
        `create:${scope.threadId}:${input.clientRequestId}`,
        Effect.gen(function* () {
          yield* requireCapability(scope);
          const all = yield* listAgents;
          const you = ownerOf(all, scope.threadId);
          const id = `team:${NodeCrypto.createHash("sha256").update(`${scope.threadId}\n${input.clientRequestId}`).digest("hex").slice(0, 32)}`;
          const existing = all.find((agent) => agent.profile.id === id);
          if (
            existing &&
            (existing.archivedAt ||
              existing.profile.name !== input.name ||
              existing.profile.description !== input.description ||
              existing.profile.instructions !== input.instructions)
          )
            return yield* failure(
              "invalid_request",
              "This creation key already belongs to a different agent. Retry the original request or use a new key.",
            );
          if (!existing) {
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* agents
              .save({
                expectedRevision: 0,
                agent: {
                  profile: {
                    id,
                    name: input.name,
                    description: input.description,
                    instructions: input.instructions,
                    color: "#3b82f6",
                    pinned: false,
                    projectKey: "",
                    runtimeMode: "inherit",
                    modelSelection: input.modelSelection ?? null,
                    blockedToolGroups: you?.profile.blockedToolGroups ?? [],
                  },
                  revision: 0,
                  archive: null,
                  memories: [],
                  primaryThreadId: null,
                  recovery: {
                    disposition: "ready",
                    summary: "Created for a new assignment.",
                    blockers: [],
                    verifiedAt: now,
                    evidence: [`Created by conversation ${scope.threadId}.`],
                  },
                  updatedAt: now,
                },
              })
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "orchestration_error",
                    "Could not save the new agent. No task was submitted.",
                  ),
                ),
              );
          }
          const result = yield* service.send(scope, {
            agent: id,
            message: input.message,
            clientRequestId: input.clientRequestId,
          });
          return { ...result, created: existing === undefined };
        }),
      ),
    list: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const all = (yield* listAgents).filter((agent) => !agent.archivedAt);
        const you = ownerOf(all, scope.threadId);
        const members = yield* Effect.forEach(
          all,
          (agent) =>
            Effect.gen(function* () {
              const threadId = agent.primaryThreadId as ThreadId | null;
              const shell =
                threadId === null
                  ? null
                  : yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
              return {
                agentId: agent.profile.id,
                name: agent.profile.name,
                role: agentRole(agent),
                status: threadId === null ? ("not_started" as const) : agentStatusFromShell(shell),
                threadId,
                currentGoal: agentCurrentGoal(agent),
                isYou: you?.profile.id === agent.profile.id,
              };
            }),
          { concurrency: 8 },
        );
        return { agents: members };
      }),
    send: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const all = yield* listAgents;
        const match = matchAgent(all, input.agent);
        if (match._tag === "ambiguous") {
          return yield* failure(
            "invalid_request",
            `More than one agent is named "${input.agent}": ${describeAgents(match.candidates)}. Send again with the agent id.`,
          );
        }
        if (match._tag === "unknown") {
          return yield* failure(
            "invalid_request",
            `No agent named "${input.agent}".${
              match.closeMatches.length > 0
                ? ` Did you mean: ${describeAgents(match.closeMatches)}?`
                : ""
            } Use agent_list to see the team.`,
          );
        }
        const target = match.agent;
        const you = ownerOf(all, scope.threadId);
        if (
          (you !== undefined && you.profile.id === target.profile.id) ||
          target.primaryThreadId === scope.threadId
        ) {
          return yield* failure("invalid_request", "An agent cannot send a message to itself.");
        }
        const callerHops = yield* hopsInto(scope.threadId);
        if (callerHops >= AGENT_MESSAGE_MAX_HOPS) {
          return yield* failure(
            "invalid_request",
            `This run is already ${callerHops} agent messages deep (limit ${AGENT_MESSAGE_MAX_HOPS}). Finish the work yourself or report back to the owner instead of passing it on.`,
          );
        }
        const targetThreadId = target.primaryThreadId
          ? ThreadId.make(target.primaryThreadId)
          : yield* ensureConversation(scope, target);
        const awaitReply = input.awaitReply ?? true;
        // The recipient only sees a message in its own conversation, so say who it is from, and
        // whether its final message goes back on its own.
        const text = you
          ? `Message from agent ${you.profile.name} (id ${you.profile.id}); ${
              awaitReply
                ? "your final message when you finish this is sent back to them automatically, so do not call agent_send only to answer."
                : "no reply is expected. Use agent_send only if you need to tell them something."
            }\n\n${input.message}`
          : input.message;
        const sent = yield* orchestrator.sendToThread(scope, {
          threadId: targetThreadId,
          message: text,
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        });
        const hops = callerHops + 1;
        const replyExpected =
          awaitReply &&
          (yield* replies.request({
            sourceMessageId: sent.messageId,
            recipientThreadId: targetThreadId,
            recipientName: target.profile.name,
            askerThreadId: scope.threadId,
            hops,
          }));
        // A run that settled before the row was written has already sent its event.
        if (replyExpected) yield* replies.settleRecipient(targetThreadId);
        return {
          agentId: target.profile.id,
          agentName: target.profile.name,
          threadId: targetThreadId,
          messageId: sent.messageId,
          runId: sent.runId,
          status: sent.status,
          delivery: sent.delivery,
          hops,
          replyExpected,
        };
      }),
  };
  return AgentTeamMcpService.of(service);
});

export const layer: Layer.Layer<
  AgentTeamMcpService,
  never,
  | AgentWorkspace.AgentWorkspace
  | ThreadManagementService.ThreadManagementService
  | OrchestratorMcpService.OrchestratorMcpService
  | AgentReplies.AgentReplies
  | ThreadLaunchService.ThreadLaunchService
  | ManagedProjectFolders.ManagedProjectFolders
  | ProjectService.ProjectService
> = Layer.effect(AgentTeamMcpService, make);
