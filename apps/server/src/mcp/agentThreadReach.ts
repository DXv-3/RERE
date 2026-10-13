import type { OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

/**
 * Whether agents may reach threads outside their own project. The settings service is a declared
 * requirement so every place these tools run is proven to carry the setting; an optional lookup
 * could silently miss it and leave the boundary on. A failed read keeps the boundary.
 */
export const crossProjectReach = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  return yield* settings.getSettings.pipe(
    Effect.map((current) => current.enableAgentCrossProjectAccess),
    Effect.orElseSucceed(() => false),
  );
});

/**
 * The project a target thread is looked up in. Every thread tool checks that the target belongs
 * to the project it passes, so the whole boundary lives here: within project reach that is the
 * caller's project, and with cross-project reach it is the target's own, which makes any live
 * thread on this server a valid target.
 */
export const reachProjectId = <E>(
  callerProjectId: ProjectId,
  threadId: ThreadId,
  getThreadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E>,
) =>
  Effect.gen(function* () {
    if (!(yield* crossProjectReach)) return callerProjectId;
    const shell = yield* getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    return shell?.projectId ?? callerProjectId;
  });
