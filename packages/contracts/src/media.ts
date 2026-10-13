import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Looking inside video and image files: facts, still frames and review notes. Bytes of the file
 * itself travel through asset URLs; this module only carries what the server derives from them.
 */

/** Files the media service reads, by extension. Everything else is refused before ffmpeg runs. */
export const MEDIA_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm", ".mkv"] as const;
export const MEDIA_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

const MEDIA_FRAMES_MAX_PER_REQUEST = 8;
const MEDIA_THUMBNAILS_MAX_COUNT = 24;
export const MEDIA_FRAME_MIN_EDGE = 64;
export const MEDIA_FRAME_MAX_EDGE = 1536;
export const MEDIA_FRAME_DEFAULT_EDGE = 768;

const MEDIA_PATH_MAX_LENGTH = 2048;

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** A rectangle as fractions (0..1) of the media's displayed width and height. */
export const MediaRegionBox = Schema.Struct({
  x: Fraction,
  y: Fraction,
  width: Fraction,
  height: Fraction,
});
export type MediaRegionBox = typeof MediaRegionBox.Type;

export const MediaKind = Schema.Literals(["video", "image"]);
export type MediaKind = typeof MediaKind.Type;

export const MediaProbe = Schema.Struct({
  kind: MediaKind,
  /** Seconds. Null for a still image. */
  durationSeconds: Schema.NullOr(Schema.Number),
  /** Displayed size, after any rotation flag the file carries. */
  width: NonNegativeInt,
  height: NonNegativeInt,
  fps: Schema.NullOr(Schema.Number),
  hasAudio: Schema.Boolean,
  codec: Schema.NullOr(Schema.String),
  sizeBytes: NonNegativeInt,
});
export type MediaProbe = typeof MediaProbe.Type;

const MediaFileInput = {
  /** The thread's working directory. The file must resolve inside it. */
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(MEDIA_PATH_MAX_LENGTH)),
} as const;

export const MediaProbeInput = Schema.Struct(MediaFileInput);
export type MediaProbeInput = typeof MediaProbeInput.Type;

export const MediaFramesInput = Schema.Struct({
  ...MediaFileInput,
  at: Schema.Array(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MEDIA_FRAMES_MAX_PER_REQUEST),
  ),
  box: Schema.optional(MediaRegionBox),
  maxEdge: Schema.optional(
    Schema.Int.check(
      Schema.isBetween({ minimum: MEDIA_FRAME_MIN_EDGE, maximum: MEDIA_FRAME_MAX_EDGE }),
    ),
  ),
});
export type MediaFramesInput = typeof MediaFramesInput.Type;

export const MediaFrame = Schema.Struct({
  at: Schema.Number,
  mimeType: Schema.Literal("image/jpeg"),
  base64: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type MediaFrame = typeof MediaFrame.Type;

export const MediaFramesResult = Schema.Struct({
  probe: MediaProbe,
  frames: Schema.Array(MediaFrame),
});
export type MediaFramesResult = typeof MediaFramesResult.Type;

export const MediaThumbnailsInput = Schema.Struct({
  ...MediaFileInput,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEDIA_THUMBNAILS_MAX_COUNT })),
});
export type MediaThumbnailsInput = typeof MediaThumbnailsInput.Type;

export const MediaThumbnailsResult = Schema.Struct({
  frames: Schema.Array(MediaFrame),
});
export type MediaThumbnailsResult = typeof MediaThumbnailsResult.Type;

export const MediaErrorReason = Schema.Literals([
  "not_found",
  "outside_workspace",
  "unsupported_type",
  "too_large",
  "too_long",
  "tool_missing",
  "tool_failed",
  "timeout",
  "unavailable",
  "invalid_request",
]);
export type MediaErrorReason = typeof MediaErrorReason.Type;

/** One error with a reason code so clients can pick the right empty or error state. */
export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  reason: MediaErrorReason,
  message: TrimmedNonEmptyString,
}) {}

/** Version of the `<file>.annotations.json` sidecar. */
export const MEDIA_ANNOTATIONS_VERSION = 1;
export const MEDIA_ANNOTATIONS_MAX_PER_FILE = 500;
const MEDIA_ANNOTATION_COMMENT_MAX_CHARS = 8_000;

export const MediaAnnotationStatus = Schema.Literals(["open", "resolved"]);
export type MediaAnnotationStatus = typeof MediaAnnotationStatus.Type;

/** One review note on a media file: a moment or range, a region, or both, plus the comment. */
export const MediaAnnotation = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  status: MediaAnnotationStatus,
  /** Seconds. Absent for a note on a whole image or a region with no time. */
  timeStart: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  timeEnd: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  box: Schema.optional(MediaRegionBox),
  comment: Schema.String.check(Schema.isMaxLength(MEDIA_ANNOTATION_COMMENT_MAX_CHARS)),
  createdAt: Schema.String,
  resolvedAt: Schema.optional(Schema.String),
});
export type MediaAnnotation = typeof MediaAnnotation.Type;

export const MediaAnnotationsFile = Schema.Struct({
  version: Schema.Literal(MEDIA_ANNOTATIONS_VERSION),
  annotations: Schema.Array(MediaAnnotation),
});
export type MediaAnnotationsFile = typeof MediaAnnotationsFile.Type;
