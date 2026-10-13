import { MediaError, type MediaProbe } from "@t3tools/contracts";
import {
  mediaAnnotationsSidecarPath,
  parseMediaAnnotationsSidecar,
  sortMediaAnnotations,
} from "@t3tools/shared/mediaAnnotations";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as MediaService from "../../../media/MediaService.ts";
import { evenlySpacedTimestamps } from "../../../media/mediaFfmpeg.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  MEDIA_INSPECT_DEFAULT_FRAMES,
  MEDIA_INSPECT_MAX_FRAMES,
  MediaToolkit,
  type MediaInspectResult,
} from "./tools.ts";

const unavailable = (message: string) => new MediaError({ reason: "unavailable", message });

/** Which moments to show: the ones asked for, else evenly spaced, and one for a still image. */
export function chooseInspectTimes(input: {
  readonly at: ReadonlyArray<number> | undefined;
  readonly count: number | undefined;
  readonly probe: Pick<MediaProbe, "kind" | "durationSeconds" | "fps">;
}): number[] {
  if (input.probe.kind === "image") return [0];
  if (input.at !== undefined && input.at.length > 0) {
    return [...input.at].slice(0, MEDIA_INSPECT_MAX_FRAMES);
  }
  const count = Math.min(
    MEDIA_INSPECT_MAX_FRAMES,
    Math.max(1, input.count ?? MEDIA_INSPECT_DEFAULT_FRAMES),
  );
  return evenlySpacedTimestamps(count, input.probe.durationSeconds, input.probe.fps);
}

/** Facts, frames and open review notes for one file; the part of the tool that needs no caller. */
export const inspectMedia = Effect.fn("media.inspectMedia")(function* (
  cwd: string,
  input: {
    readonly file: string;
    readonly at?: ReadonlyArray<number> | undefined;
    readonly count?: number | undefined;
  },
) {
  const media = yield* MediaService.MediaService;
  const probe = yield* media.probe({ cwd, relativePath: input.file });
  const times = chooseInspectTimes({ at: input.at, count: input.count, probe });
  const { frames } = yield* media.frames({
    cwd,
    relativePath: input.file,
    at: times,
  });

  const notes: string[] = [];
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const sidecar = yield* files
    .readFile({ cwd, relativePath: mediaAnnotationsSidecarPath(input.file) })
    .pipe(Effect.option);
  let openAnnotations: MediaInspectResult["openAnnotations"] = [];
  if (Option.isSome(sidecar)) {
    const parsed = parseMediaAnnotationsSidecar(sidecar.value.contents);
    if (parsed.status === "ok") {
      openAnnotations = sortMediaAnnotations(
        parsed.annotations.filter((annotation) => annotation.status === "open"),
      ).map(({ id, timeStart, timeEnd, box, comment }) => ({
        id,
        comment,
        ...(timeStart === undefined ? {} : { timeStart }),
        ...(timeEnd === undefined ? {} : { timeEnd }),
        ...(box === undefined ? {} : { box }),
      }));
      if (parsed.dropped > 0) notes.push(`${parsed.dropped} review note(s) could not be read.`);
    } else {
      notes.push("The review notes file next to this file could not be read.");
    }
  }
  return {
    file: input.file,
    probe,
    frames,
    openAnnotations,
    notes,
  } satisfies MediaInspectResult;
});

/** The tool result as the model reads it: JSON facts plus one image block per frame. */
export function mediaInspectOutput(result: MediaInspectResult) {
  const { frames, ...rest } = result;
  return {
    metadata: { ...rest, frames: frames.map(({ base64: _base64, ...frame }) => frame) },
    images: frames.map((frame) => ({ data: frame.base64, mimeType: frame.mimeType })),
  };
}

export const MediaToolkitHandlersLive = MediaToolkit.toLayer({
  media_inspect: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (!scope.capabilities.has("media")) {
        return yield* unavailable(
          McpInvocationContext.capabilityDeniedMessage(
            scope,
            "media",
            "This credential cannot inspect media files.",
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
      const cwd = caller.worktreePath ?? project.value.workspaceRoot;

      return yield* inspectMedia(cwd, input);
    }),
});
