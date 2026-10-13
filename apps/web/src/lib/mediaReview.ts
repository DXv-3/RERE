import {
  MEDIA_IMAGE_EXTENSIONS,
  MEDIA_VIDEO_EXTENSIONS,
  type MediaKind,
  type MediaRegionBox,
} from "@t3tools/contracts";

/**
 * Geometry and timing for the media viewer: where a pointer lands on the picture, how a box is
 * drawn and resized, and how time moves on the scrubber and the timeline. Pure so the maths is
 * testable without a video element.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PixelRect extends Point, Size {}

/** Smallest box side, as a fraction of the picture, that counts as a deliberate drag. */
const MIN_BOX_FRACTION = 0.02;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Where the picture actually sits inside its element. A video with `object-fit: contain` leaves
 * bars at the sides or top; a pointer on a bar is not on the picture.
 */
export function containedContentBox(container: Size, media: Size): PixelRect {
  if (container.width <= 0 || container.height <= 0 || media.width <= 0 || media.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / media.width, container.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

/** Pointer position (relative to the container) as fractions of the picture, clamped to it. */
export function pointerToMediaFraction(point: Point, content: PixelRect): Point | null {
  if (content.width <= 0 || content.height <= 0) return null;
  return {
    x: clamp((point.x - content.x) / content.width, 0, 1),
    y: clamp((point.y - content.y) / content.height, 0, 1),
  };
}

export function isPointOnContent(point: Point, content: PixelRect): boolean {
  return (
    point.x >= content.x &&
    point.x <= content.x + content.width &&
    point.y >= content.y &&
    point.y <= content.y + content.height
  );
}

/** The rectangle spanned by two fraction points, whichever way it was dragged. */
export function boxFromPoints(a: Point, b: Point): MediaRegionBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function isMeaningfulBox(box: MediaRegionBox): boolean {
  return box.width >= MIN_BOX_FRACTION && box.height >= MIN_BOX_FRACTION;
}

export type BoxHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

/** Handle name to the edges it drags. */
const HANDLE_EDGES: Record<
  Exclude<BoxHandle, "move">,
  { left: boolean; right: boolean; top: boolean; bottom: boolean }
> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

export const BOX_HANDLES = Object.keys(HANDLE_EDGES) as Array<Exclude<BoxHandle, "move">>;

/**
 * Applies a handle drag. `delta` is the pointer movement in picture fractions since the drag
 * began and `start` the box at that moment. Edges cross over rather than collapse, and the box
 * stays inside the picture.
 */
export function dragBox(start: MediaRegionBox, handle: BoxHandle, delta: Point): MediaRegionBox {
  if (handle === "move") {
    return {
      ...start,
      x: clamp(start.x + delta.x, 0, 1 - start.width),
      y: clamp(start.y + delta.y, 0, 1 - start.height),
    };
  }
  const edges = HANDLE_EDGES[handle];
  let left = start.x;
  let right = start.x + start.width;
  let top = start.y;
  let bottom = start.y + start.height;
  if (edges.left) left = clamp(left + delta.x, 0, 1);
  if (edges.right) right = clamp(right + delta.x, 0, 1);
  if (edges.top) top = clamp(top + delta.y, 0, 1);
  if (edges.bottom) bottom = clamp(bottom + delta.y, 0, 1);
  return boxFromPoints({ x: left, y: top }, { x: right, y: bottom });
}

export function boxToPixels(box: MediaRegionBox, content: PixelRect): PixelRect {
  return {
    x: content.x + box.x * content.width,
    y: content.y + box.y * content.height,
    width: box.width * content.width,
    height: box.height * content.height,
  };
}

/** Rounded for display and the agent's text; the stored box keeps full precision. */
export function formatBoxPercent(box: MediaRegionBox): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return `x ${percent(box.x)}, y ${percent(box.y)}, ${percent(box.width)} wide, ${percent(box.height)} tall`;
}

/** `m:ss.cc`, with hours only when needed. */
export function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalCentis = Math.round(safe * 100);
  const centis = totalCentis % 100;
  const totalSeconds = Math.floor(totalCentis / 100);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis)}`
    : `${minutes}:${pad(secs)}.${pad(centis)}`;
}

export function formatTimeRange(start: number, end: number | undefined): string {
  return end === undefined || Math.abs(end - start) < 0.005
    ? formatTimecode(start)
    : `${formatTimecode(start)} – ${formatTimecode(end)}`;
}

/** Frame rate used for stepping when the file does not report one. */
const FALLBACK_FPS = 30;

/**
 * One step of the playhead. A frame lands on the next frame boundary rather than adding a
 * fraction to wherever the playhead happens to be, so repeated steps never drift.
 */
export function stepTime(input: {
  readonly current: number;
  readonly duration: number;
  readonly fps: number | null;
  readonly direction: 1 | -1;
  /** A whole second instead of one frame. */
  readonly coarse: boolean;
}): number {
  const fps = input.fps && input.fps > 0 ? input.fps : FALLBACK_FPS;
  const period = 1 / fps;
  const next = input.coarse
    ? input.current + input.direction
    : input.direction === 1
      ? (Math.floor(input.current * fps + 1e-6) + 1) * period
      : (Math.ceil(input.current * fps - 1e-6) - 1) * period;
  // Land inside the last frame, not on the end where nothing is drawn.
  return clamp(next, 0, Math.max(0, input.duration - period / 2));
}

export interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/** A dragged or marked range, ordered and kept inside the clip. */
export function normalizeRange(a: number, b: number, duration: number): TimeRange {
  const start = clamp(Math.min(a, b), 0, Math.max(0, duration));
  const end = clamp(Math.max(a, b), 0, Math.max(0, duration));
  return { start, end };
}

/** Time under a horizontal pixel position on the timeline. */
export function timeAtTimelineX(x: number, timelineWidth: number, duration: number): number {
  if (timelineWidth <= 0 || duration <= 0) return 0;
  return clamp(x / timelineWidth, 0, 1) * duration;
}

/** Horizontal position as a 0..1 fraction of the timeline. */
export function timelineFraction(time: number, duration: number): number {
  return duration <= 0 ? 0 : clamp(time / duration, 0, 1);
}

/** A drag shorter than this many seconds on the timeline is a click, so it seeks and selects nothing. */
export const MIN_DRAG_RANGE_SECONDS = 0.1;

/**
 * Mark In and Mark Out at the playhead. The second mark closes the range whichever order the
 * two were set in; with only one mark the range is that single moment.
 */
export function rangeFromMarks(input: {
  readonly markIn: number | null;
  readonly markOut: number | null;
  readonly duration: number;
}): TimeRange | null {
  const { markIn, markOut } = input;
  if (markIn === null && markOut === null) return null;
  if (markIn === null || markOut === null) {
    const only = clamp((markIn ?? markOut) as number, 0, Math.max(0, input.duration));
    return { start: only, end: only };
  }
  return normalizeRange(markIn, markOut, input.duration);
}

/** Whether a note's outline should show at the playhead. Notes with no time always show. */
export function isAnnotationActiveAt(
  annotation: { readonly timeStart?: number | undefined; readonly timeEnd?: number | undefined },
  time: number,
  /** Half a frame by default, so a single-moment note shows on its own frame. */
  tolerance = 0.05,
): boolean {
  if (annotation.timeStart === undefined) return true;
  const end = annotation.timeEnd ?? annotation.timeStart;
  return time >= annotation.timeStart - tolerance && time <= end + tolerance;
}

const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;

export function nextPlaybackRate(current: number): number {
  const index = PLAYBACK_RATES.findIndex((rate) => rate === current);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
}

/** Frames sent with a media note are image attachments with this name prefix. */
export const MEDIA_FRAME_NAME_PREFIX = "media-frame-";

/** Whether the media service can read this file, and as what. SVG and audio stay with the plain preview. */
export function mediaReviewKindForPath(path: string): MediaKind | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = path.slice(dot).toLowerCase();
  if ((MEDIA_VIDEO_EXTENSIONS as ReadonlyArray<string>).includes(extension)) return "video";
  if ((MEDIA_IMAGE_EXTENSIONS as ReadonlyArray<string>).includes(extension)) return "image";
  return null;
}

export type ReviewKeyAction =
  | { readonly type: "toggle-play" }
  | { readonly type: "step"; readonly direction: 1 | -1; readonly coarse: boolean }
  | { readonly type: "mark-in" }
  | { readonly type: "mark-out" }
  | { readonly type: "escape" };

export interface ReviewKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  /** Where the key landed: text fields keep their own keys, and buttons keep Space. */
  readonly target: { readonly tagName: string; readonly isContentEditable?: boolean } | null;
}

/**
 * What a key press means in the viewer. Typing in the comment box never steers the video, and
 * Space on a focused button presses that button instead of toggling playback.
 */
export function reviewKeyAction(event: ReviewKeyEvent, isVideo: boolean): ReviewKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const tag = event.target?.tagName.toUpperCase() ?? "";
  if (
    event.target?.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT"
  ) {
    return null;
  }
  if (event.key === "Escape") return { type: "escape" };
  if (!isVideo) return null;
  switch (event.key) {
    case " ":
      return tag === "BUTTON" || tag === "A" ? null : { type: "toggle-play" };
    case "ArrowLeft":
    case ",":
      return { type: "step", direction: -1, coarse: event.shiftKey };
    case "ArrowRight":
    case ".":
      return { type: "step", direction: 1, coarse: event.shiftKey };
    case "<":
      return { type: "step", direction: -1, coarse: true };
    case ">":
      return { type: "step", direction: 1, coarse: true };
    case "i":
    case "I":
      return { type: "mark-in" };
    case "o":
    case "O":
      return { type: "mark-out" };
    default:
      return null;
  }
}

/** The box "Select region" starts from, for people who adjust it with the keyboard. */
export const DEFAULT_KEYBOARD_BOX: MediaRegionBox = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
