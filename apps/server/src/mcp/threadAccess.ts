import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { crossProjectReach, reachProjectId } from "./agentThreadReach.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

/**
 * How far a tool reaches. Most tools leave the calling thread (other threads, projects, the
 * scheduler, new conversations) and need Other Conversations, so that is the default and a tool
 * that only touches the calling thread has to say so. An agent whose owner switched Other
 * Conversations off keeps the second kind.
 */
export type ThreadReach = "own-thread" | "other-conversations";

const cannotControlThreads = (scope: McpInvocationContext.McpInvocationScope) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: McpInvocationContext.capabilityDeniedMessage(
      scope,
      "orchestration",
      "This credential cannot control threads.",
    ),
  });

/** The refusal for a call that would leave the calling thread when the owner switched it off. */
export const requireOtherConversations = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.capabilities.has("orchestration") ? Effect.void : Effect.fail(cannotControlThreads(scope));

export const readCaller = Effect.fn("mcp.readCaller")(function* (
  reach: ThreadReach = "other-conversations",
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (reach === "own-thread") {
    if (!McpInvocationContext.holdsOrchestration(scope)) return yield* cannotControlThreads(scope);
  } else {
    yield* requireOtherConversations(scope);
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(scope.threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationContext.McpInvocationScope;
}) {
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* (
  reach: ThreadReach = "other-conversations",
) {
  const context = yield* readCaller(reach);
  yield* assertLiveCaller(context);
  return context;
});

/** Resolve the project the caller may reach before looking up a caller-supplied thread. */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const { scope, threads, caller } = yield* readCaller("own-thread");
  const targetId = threadId ?? caller.id;
  if (targetId !== caller.id) yield* requireOtherConversations(scope);
  const projectId = yield* reachProjectId(caller.projectId, targetId, threads.getThreadShell);
  const projection = yield* threads
    .getProjectThreadRecords({ projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request"],
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found in the calling project.",
            })
          : unavailable(),
      ),
    );
  return { scope, threads, caller, projection };
});

export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  yield* assertLiveCaller(context);
  // Cross-project reach also lets a caller direct a thread with broader permissions than its own.
  if (yield* crossProjectReach) return context;
  yield* OrchestrationMcp.resolveRuntimeMode(
    context.caller.runtimeMode,
    context.projection.thread.runtimeMode,
  );
  yield* OrchestrationMcp.resolveInteractionMode(
    context.caller.interactionMode,
    context.projection.thread.interactionMode,
  );
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
