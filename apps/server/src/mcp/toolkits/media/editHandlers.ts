import { MediaError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as MediaEdit from "../../../media/MediaEdit.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MediaEditToolkit, type MediaEditToolResult } from "./editTools.ts";

const unavailable = (message: string) => new MediaError({ reason: "unavailable", message });

const NEXT =
  "Look at this file with media_inspect before you say the work is done, and tell the person which file you made.";

/** Runs one edit and words the result for the agent. The part of the tool that needs no caller. */
export const editMedia = Effect.fn("media.editMedia")(function* (
  cwd: string,
  input: MediaEdit.MediaEditParameters,
) {
  const parsed = MediaEdit.toEditRequest(input);
  if ("error" in parsed) return yield* parsed.error;
  const service = yield* MediaEdit.MediaEdit;
  const result = yield* service.edit(cwd, parsed.request);
  return { ...result, next: NEXT } satisfies MediaEditToolResult;
});

export const MediaEditToolkitHandlersLive = MediaEditToolkit.toLayer({
  media_edit: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("media")) {
        return yield* unavailable(
          McpInvocationContext.capabilityDeniedMessage(
            scope,
            "media",
            "This credential cannot edit media files.",
          ),
        );
      }
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const caller = yield* threads
        .getThreadShell(scope.threadId)
        .pipe(Effect.mapError(() => unavailable("The calling thread could not be read.")));
      if (caller === null) return yield* unavailable("The calling thread was not found.");
      const project = yield* (yield* ProjectService.ProjectService)
        .getById(caller.projectId)
        .pipe(Effect.mapError(() => unavailable("The thread's project could not be read.")));
      if (Option.isNone(project)) return yield* unavailable("The thread's project was not found.");
      return yield* editMedia(caller.worktreePath ?? project.value.workspaceRoot, input);
    }),
});
