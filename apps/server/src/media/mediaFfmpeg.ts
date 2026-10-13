import {
  MEDIA_FRAME_DEFAULT_EDGE,
  MEDIA_FRAME_MAX_EDGE,
  MEDIA_FRAME_MIN_EDGE,
  MEDIA_IMAGE_EXTENSIONS,
  MEDIA_VIDEO_EXTENSIONS,
  type MediaKind,
  type MediaProbe,
  type MediaRegionBox,
} from "@t3tools/contracts";

/** Pure helpers behind the media service: what to ask ffprobe/ffmpeg and how to read the answers. */

/** Longest video the service will seek in. Longer files are refused rather than slowly scanned. */
export const MEDIA_MAX_DURATION_SECONDS = 6 * 60 * 60;
export const MEDIA_MAX_VIDEO_BYTES = 16 * 1024 ** 3;
export const MEDIA_MAX_IMAGE_BYTES = 64 * 1024 ** 2;

export const THUMBNAIL_EDGE = 160;

export function mediaKindFromExtension(extension: string): MediaKind | null {
  const lower = extension.toLowerCase();
  if ((MEDIA_VIDEO_EXTENSIONS as ReadonlyArray<string>).includes(lower)) return "video";
  if ((MEDIA_IMAGE_EXTENSIONS as ReadonlyArray<string>).includes(lower)) return "image";
  return null;
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly r_frame_rate?: string;
  readonly duration?: string;
  readonly tags?: { readonly rotate?: string };
  readonly side_data_list?: ReadonlyArray<{ readonly rotation?: number }>;
}

interface FfprobeJson {
  readonly streams?: ReadonlyArray<FfprobeStream>;
  readonly format?: { readonly duration?: string };
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [numerator, denominator] = rate.split("/").map(Number);
  if (numerator === undefined || !Number.isFinite(numerator) || numerator <= 0) return null;
  const value = denominator === undefined ? numerator : numerator / denominator;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

function rotationDegrees(stream: FfprobeStream): number {
  const fromSideData = stream.side_data_list?.find((entry) => entry.rotation !== undefined);
  const raw = fromSideData?.rotation ?? Number(stream.tags?.rotate ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Reads `ffprobe -print_format json -show_streams -show_format`. Width and height are the
 * displayed size: a phone clip flagged as rotated 90 degrees reports height as width.
 */
export function parseProbeJson(
  text: string,
  kind: MediaKind,
  sizeBytes: number,
): MediaProbe | null {
  let json: FfprobeJson;
  try {
    json = JSON.parse(text) as FfprobeJson;
  } catch {
    return null;
  }
  const streams = json.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video || !video.width || !video.height) return null;
  const turned = Math.abs(Math.round(rotationDegrees(video) / 90)) % 2 === 1;
  const duration = Number(json.format?.duration ?? video.duration);
  return {
    kind,
    durationSeconds:
      kind === "video" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    width: turned ? video.height : video.width,
    height: turned ? video.width : video.height,
    fps:
      kind === "video" ? (parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)) : null,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    codec: video.codec_name ?? null,
    sizeBytes,
  };
}

/**
 * Keeps a timestamp where a frame exists: inside the clip and at least two frame periods short
 * of its end, because seeking past the last frame's start decodes nothing.
 */
export function clampTimestamp(
  seconds: number,
  durationSeconds: number | null,
  fps: number | null = null,
): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (durationSeconds === null) return 0;
  const margin = Math.max(0.1, fps ? 2 / fps : 0);
  return Math.min(seconds, Math.max(0, durationSeconds - margin));
}

/** `count` moments spread evenly through the clip, each in the middle of its slice. */
export function evenlySpacedTimestamps(
  count: number,
  durationSeconds: number | null,
  fps: number | null = null,
): number[] {
  if (durationSeconds === null || durationSeconds <= 0 || count <= 1) {
    return [
      clampTimestamp(durationSeconds === null ? 0 : durationSeconds / 2, durationSeconds, fps),
    ];
  }
  return Array.from({ length: count }, (_, index) =>
    clampTimestamp(((index + 0.5) / count) * durationSeconds, durationSeconds, fps),
  );
}

/** Rounded so near-identical requests share one cached frame. */
export function roundTimestamp(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

export function clampEdge(edge: number | undefined, fallback = MEDIA_FRAME_DEFAULT_EDGE): number {
  const value = edge ?? fallback;
  return Math.min(MEDIA_FRAME_MAX_EDGE, Math.max(MEDIA_FRAME_MIN_EDGE, Math.round(value)));
}

const fraction = (value: number) => Math.min(1, Math.max(0, value)).toFixed(5);

/**
 * The `-vf` chain for one frame: scale so neither side passes `maxEdge`, then draw the box.
 * The box is drawn after scaling so its stroke stays the same weight at every size, and its
 * coordinates are expressions of the filter's own `iw`/`ih`, which already include rotation.
 */
export function buildFrameFilter(input: {
  readonly maxEdge: number;
  readonly box?: MediaRegionBox | undefined;
}): string {
  const edge = Math.round(input.maxEdge);
  // `min` keeps a small source from being enlarged to fill the edge.
  const filters = [
    `scale=w=min(iw\\,${edge}):h=min(ih\\,${edge}):force_original_aspect_ratio=decrease:force_divisible_by=2`,
  ];
  if (input.box) {
    const { x, y, width, height } = input.box;
    const right = Math.min(1, x + width);
    const bottom = Math.min(1, y + height);
    const rect =
      `x=iw*${fraction(x)}:y=ih*${fraction(y)}` +
      `:w=iw*${fraction(right - x)}:h=ih*${fraction(bottom - y)}`;
    // A white border under a red one keeps the box visible on any background.
    filters.push(
      `drawbox=${rect}:color=white@0.95:t=max(4\\,min(iw\\,ih)/90)`,
      `drawbox=${rect}:color=red@0.95:t=max(2\\,min(iw\\,ih)/180)`,
    );
  }
  return filters.join(",");
}

/**
 * ffmpeg picks a reader from the file's contents, not its name, so a playlist saved as `.mp4`
 * could point it at other files or at the network. Only the readers for the supported types run,
 * and only from local files.
 */
export const INPUT_GUARD_ARGS = [
  "-format_whitelist",
  "mov,matroska,image2,png_pipe,jpeg_pipe,webp_pipe,gif",
  "-protocol_whitelist",
  "file",
] as const;

export function buildFrameArgs(input: {
  readonly kind: MediaKind;
  readonly filePath: string;
  readonly seconds: number;
  readonly filter: string;
  readonly outputPath: string;
}): string[] {
  return [
    "-nostdin",
    "-v",
    "error",
    // Seeking before the input jumps by keyframe, so a frame deep in a long clip stays cheap.
    ...(input.kind === "video" ? ["-ss", input.seconds.toFixed(3)] : []),
    ...INPUT_GUARD_ARGS,
    "-i",
    input.filePath,
    "-frames:v",
    "1",
    "-vf",
    input.filter,
    "-q:v",
    "3",
    "-f",
    "image2",
    "-y",
    input.outputPath,
  ];
}

export function buildProbeArgs(filePath: string): string[] {
  return [
    "-v",
    "error",
    ...INPUT_GUARD_ARGS,
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath,
  ];
}

/** Size of a frame after `buildFrameFilter` scaling, for reporting without decoding the output. */
export function scaledFrameSize(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  const fit = Math.min(1, maxEdge / Math.max(width, height, 1));
  const even = (value: number) => Math.max(2, Math.floor((value * fit) / 2) * 2);
  return { width: even(width), height: even(height) };
}
