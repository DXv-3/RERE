import {
  goalIdFromTaskId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentGoals from "./AgentGoals.ts";

/** Run ids already looked at, so a repeated terminal event costs nothing. Cleared when it grows this large. */
const SEEN_RUN_LIMIT = 5_000;

/**
 * Files a `fallback` check-in for a goal turn that ended without the agent reporting.
 * A run is a goal turn when the user message that started it carries a goal task's id:
 * the scheduler stamps `scheduledTaskId` on the message, and the message survives
 * queueing, so it is the one reliable link from a run back to the task.
 */
export class AgentGoalFallback extends Context.Service<
  AgentGoalFallback,
  {
    /** Handles one run update. Resolves true when it filed a check-in. */
    readonly handleRunUpdate: (run: OrchestrationV2Run) => Effect.Effect<boolean>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agents/AgentGoalFallback") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const goals = yield* AgentGoals.AgentGoals;
  const seen = new Set<string>();

  const goalIdOfRun = Effect.fn("AgentGoalFallback.goalIdOfRun")(function* (
    run: OrchestrationV2Run,
  ) {
    const { messages } = yield* threads.getThreadRecords(run.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const taskId = messages.find((message) => message.id === run.userMessageId)?.scheduledTaskId;
    return taskId === undefined ? null : goalIdFromTaskId(taskId);
  });

  const finalReply = Effect.fn("AgentGoalFallback.finalReply")(function* (run: OrchestrationV2Run) {
    const { messages } = yield* threads.getThreadRecords(run.threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["assistant"],
    });
    const reply = messages
      .filter((message) => message.runId === run.id && !message.streaming)
      .map((message) => assistantCitationsToPlainText(message.text).trim())
      .findLast((text) => text.length > 0);
    return reply ?? `The goal turn ended as ${run.status} without filing a check-in.`;
  });

  const handleRunUpdate: AgentGoalFallback["Service"]["handleRunUpdate"] = (run) =>
    Effect.gen(function* () {
      if (!ThreadManagementService.isTerminalRunStatus(run.status) || seen.has(run.id)) {
        return false;
      }
      const goalId = yield* goalIdOfRun(run);
      if (goalId !== null) {
        const summary = yield* finalReply(run);
        const filed = yield* goals
          .fileFallbackCheckIn({ goalId, threadId: run.threadId, runId: run.id, summary })
          .pipe(
            // A goal deleted while its turn ran has nowhere to report to.
            Effect.catchTag("AgentGoalError", (error) =>
              error.reason === "goal_not_found" ? Effect.succeed(null) : Effect.fail(error),
            ),
          );
        if (seen.size >= SEEN_RUN_LIMIT) seen.clear();
        seen.add(run.id);
        return filed !== null;
      }
      if (seen.size >= SEEN_RUN_LIMIT) seen.clear();
      seen.add(run.id);
      return false;
    }).pipe(
      // Not marked seen on failure: a later update for the same run gets another try.
      Effect.catchCause((cause) =>
        Effect.logWarning("goal fallback check-in could not be filed", {
          runId: run.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const start: AgentGoalFallback["Service"]["start"] = Effect.fn("AgentGoalFallback.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event: OrchestrationV2DomainEvent) =>
          event.type === "run.updated" ? handleRunUpdate(event.payload) : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("goal fallback watcher stopped", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    },
  );

  return AgentGoalFallback.of({ handleRunUpdate, start });
});

export const layer = Layer.effect(AgentGoalFallback, make);
