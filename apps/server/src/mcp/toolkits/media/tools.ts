import { MediaError, MediaFrame, MediaProbe } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MediaService from "../../../media/MediaService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";

/** Most frames one call may return, however they were asked for. */
export const MEDIA_INSPECT_MAX_FRAMES = 8;
export const MEDIA_INSPECT_DEFAULT_FRAMES = 4;

export const MediaInspectInput = Schema.Struct({
  file: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
    description:
      "Path of a video (mp4, mov, m4v, webm, mkv) or image (png, jpg, webp, gif) inside this thread's folder, relative to it.",
  }),
  at: Schema.optional(
    Schema.Array(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
      .check(Schema.isMaxLength(MEDIA_INSPECT_MAX_FRAMES))
      .annotate({ description: "Moments to look at, in seconds. Takes priority over count." }),
  ),
  count: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEDIA_INSPECT_MAX_FRAMES })).annotate({
      description: `How many evenly spaced frames to look at when at is not given. Defaults to ${MEDIA_INSPECT_DEFAULT_FRAMES}.`,
    }),
  ),
});

const InspectedFrame = Schema.Struct({
  ...MediaFrame.fields,
  /** The image itself rides as an image block, not in the JSON text. */
  base64: Schema.String,
});

/** A review note the viewer saved beside the file, as the agent should read it. */
const OpenReviewNote = Schema.Struct({
  id: Schema.String,
  timeStart: Schema.optional(Schema.Number),
  timeEnd: Schema.optional(Schema.Number),
  box: Schema.optional(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  comment: Schema.String,
});

export const MediaInspectResult = Schema.Struct({
  file: Schema.String,
  probe: MediaProbe,
  frames: Schema.Array(InspectedFrame),
  /** Notes still open in `<file>.annotations.json`. */
  openAnnotations: Schema.Array(OpenReviewNote),
  /** What could not be read or was left out, in words. */
  notes: Schema.Array(Schema.String),
});
export type MediaInspectResult = typeof MediaInspectResult.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MediaService.MediaService,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  WorkspaceFileSystem.WorkspaceFileSystem,
];

export const MediaInspectTool = Tool.make("media_inspect", {
  description:
    "Look at a video or image file in this thread's folder. Returns its facts (duration, size, frame rate, audio, codec) as text and still frames as images you can see, plus any review notes people left open on it in the media viewer. By default you get a handful of evenly spaced frames; pass at (seconds) to look at specific moments or count for more or fewer evenly spaced ones, up to 8. Frames are scaled to 768 px. Needs ffmpeg on the machine running the server.",
  parameters: MediaInspectInput,
  success: MediaInspectResult,
  failure: MediaError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect video or image")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MediaToolkit = Toolkit.make(MediaInspectTool);
