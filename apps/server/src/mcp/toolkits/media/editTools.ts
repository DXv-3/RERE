import { MediaError, MediaProbe } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as MediaEdit from "../../../media/MediaEdit.ts";
import {
  MEDIA_EDIT_CAPTION_TEXT_MAX,
  MEDIA_EDIT_CAPTIONS_MAX,
  MEDIA_EDIT_JOIN_MAX,
  MEDIA_EDIT_JOIN_MIN,
  MEDIA_EDIT_OPERATIONS,
  PLATFORM_SHAPE_NAMES,
} from "../../../media/MediaEditFfmpeg.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const path = (description: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({ description });

const seconds = (description: string) =>
  Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description });

export const MediaEditInput = Schema.Struct({
  operation: Schema.Literals(MEDIA_EDIT_OPERATIONS).annotate({
    description:
      "trim (needs file, start, end), join (needs files), resize (needs file, shape; optional fit), captions (needs file, captions), mute (needs file), extract-audio (needs file), poster (needs file, at).",
  }),
  file: Schema.optional(
    path(
      "The video (or, for resize, image) to work on: a path inside this thread's folder, relative to it. Used by every operation except join.",
    ),
  ),
  files: Schema.optional(
    Schema.Array(path("A video in this thread's folder, relative to it."))
      .check(Schema.isMinLength(MEDIA_EDIT_JOIN_MIN), Schema.isMaxLength(MEDIA_EDIT_JOIN_MAX))
      .annotate({
        description: `join only: ${MEDIA_EDIT_JOIN_MIN} to ${MEDIA_EDIT_JOIN_MAX} videos, in the order they should play. They are re-encoded to the first one's size and frame rate.`,
      }),
  ),
  start: Schema.optional(seconds("trim only: where the piece to keep begins, in seconds.")),
  end: Schema.optional(
    seconds("trim only: where it ends, in seconds. A time past the end of the clip is cut there."),
  ),
  shape: Schema.optional(
    Schema.Literals(PLATFORM_SHAPE_NAMES).annotate({
      description:
        "resize only: vertical 1080x1920 (Reels, TikTok, Shorts), square 1080x1080, landscape 1920x1080, portrait-4x5 1080x1350 (Instagram feed).",
    }),
  ),
  fit: Schema.optional(
    Schema.Literals(["crop", "pad"]).annotate({
      description:
        "resize only. crop (the default) fills the shape and cuts the overflow evenly from both sides. pad keeps the whole picture and fills the rest with a blurred copy of it.",
    }),
  ),
  captions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        start: seconds("When the caption appears, in seconds."),
        end: seconds("When it goes away, in seconds. Must be after start."),
        text: Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(MEDIA_EDIT_CAPTION_TEXT_MAX),
        ).annotate({ description: "Plain text. A new line starts a second line of the caption." }),
      }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(MEDIA_EDIT_CAPTIONS_MAX))
      .annotate({
        description: `captions only: up to ${MEDIA_EDIT_CAPTIONS_MAX} captions, burned into the picture at the bottom centre.`,
      }),
  ),
  at: Schema.optional(seconds("poster only: the second to take the still from.")),
});

export const MediaEditResult = Schema.Struct({
  operation: Schema.Literals(MEDIA_EDIT_OPERATIONS),
  /** The new file, relative to this thread's folder. Tell the person about it. */
  file: Schema.String,
  /** Facts about the new video or image. Null when the new file is audio. */
  probe: Schema.NullOr(MediaProbe),
  audio: Schema.NullOr(
    Schema.Struct({
      durationSeconds: Schema.NullOr(Schema.Number),
      sizeBytes: Schema.Number,
    }),
  ),
  reencoded: Schema.Boolean,
  notes: Schema.Array(Schema.String),
  /** What to do next, in words. */
  next: Schema.String,
});
export type MediaEditToolResult = typeof MediaEditResult.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  MediaEdit.MediaEdit,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
];

export const MediaEditTool = Tool.make("media_edit", {
  description:
    "Make an edited copy of a video in this thread's folder with ffmpeg: trim, join, resize to a social shape (vertical, square, landscape, portrait-4x5), burn in captions, mute, extract the audio as m4a, or save a still frame (poster). One operation per call. It never changes the original: the result is a new file beside the first input named <name>.<operation>-<n>.<ext>, so always work on a copy and tell the person which file you made. Most operations re-encode (a join always does) and produce an mp4. Afterwards look at the result with media_inspect before you say the work is done. Needs ffmpeg on the machine running the server.",
  parameters: MediaEditInput,
  success: MediaEditResult,
  failure: MediaError,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Edit video")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const MediaEditToolkit = Toolkit.make(MediaEditTool);
