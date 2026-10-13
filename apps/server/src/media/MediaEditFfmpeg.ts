import { INPUT_GUARD_ARGS } from "./mediaFfmpeg.ts";

/**
 * Pure helpers behind `MediaEdit`: what to ask ffmpeg for each operation. Nothing here runs a
 * process, and no caller-supplied text is ever placed in a filter string: filters only carry
 * numbers this module computed, and caption text goes into an ASS file instead.
 */

export const MEDIA_EDIT_OPERATIONS = [
  "trim",
  "join",
  "resize",
  "captions",
  "mute",
  "extract-audio",
  "poster",
] as const;
export type MediaEditOperation = (typeof MEDIA_EDIT_OPERATIONS)[number];

export const MEDIA_EDIT_JOIN_MIN = 2;
export const MEDIA_EDIT_JOIN_MAX = 10;
export const MEDIA_EDIT_CAPTIONS_MAX = 200;
export const MEDIA_EDIT_CAPTION_TEXT_MAX = 200;
/** Edits never write more than this; ffmpeg stops at the limit and the result is refused. */
export const MEDIA_EDIT_MAX_OUTPUT_BYTES = 2_000_000_000;

export const PLATFORM_SHAPES = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 },
  "portrait-4x5": { width: 1080, height: 1350 },
} as const;
export type PlatformShape = keyof typeof PLATFORM_SHAPES;
export const PLATFORM_SHAPE_NAMES = Object.keys(PLATFORM_SHAPES) as [
  PlatformShape,
  ...PlatformShape[],
];

export type ResizeFit = "crop" | "pad";

export interface Caption {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const H264_ARGS = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
] as const;
const FAST_START_ARGS = ["-movflags", "+faststart"] as const;
/** Output-side options for every re-encoded video: widely playable H.264 + AAC in an mp4. */
const VIDEO_OUTPUT_ARGS = [
  ...H264_ARGS,
  "-c:a",
  "aac",
  "-b:a",
  "160k",
  ...FAST_START_ARGS,
] as const;

/** libx264 needs even sides; sources with odd ones are trimmed by a pixel. */
const EVEN_SIZE_FILTER = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

const BASE_ARGS = ["-nostdin", "-v", "error", "-n"] as const;

const sizeLimitArgs = ["-fs", String(MEDIA_EDIT_MAX_OUTPUT_BYTES)] as const;

const guardedInput = (filePath: string): string[] => [...INPUT_GUARD_ARGS, "-i", filePath];

const seconds = (value: number) => value.toFixed(3);

export function buildTrimArgs(input: {
  readonly filePath: string;
  readonly start: number;
  readonly end: number;
  readonly outputPath: string;
}): string[] {
  return [
    ...BASE_ARGS,
    // Seeking before the input and re-encoding gives a cut on the exact frame.
    "-ss",
    seconds(input.start),
    ...guardedInput(input.filePath),
    "-t",
    seconds(input.end - input.start),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    EVEN_SIZE_FILTER,
    ...VIDEO_OUTPUT_ARGS,
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

export interface JoinClip {
  readonly filePath: string;
  readonly durationSeconds: number;
  readonly hasAudio: boolean;
}

/** Common frame rate for a join: the first clip's, kept inside what players handle. */
export function joinFrameRate(fps: number | null): number {
  if (fps === null || !Number.isFinite(fps)) return 30;
  return Math.min(60, Math.max(10, Math.round(fps * 100) / 100));
}

const evenSide = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/**
 * Every clip is fitted inside the first clip's size (black bars, never stretched), set to one
 * frame rate and one audio format, then concatenated. A clip with no sound gets silence for its
 * length so the sound of the others stays in step. With no sound anywhere the result has none.
 */
export function buildJoinArgs(input: {
  readonly clips: ReadonlyArray<JoinClip>;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly outputPath: string;
}): string[] {
  const width = evenSide(input.width);
  const height = evenSide(input.height);
  const anyAudio = input.clips.some((clip) => clip.hasAudio);
  const parts: string[] = [];
  const labels: string[] = [];
  input.clips.forEach((clip, index) => {
    parts.push(
      `[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${input.fps},format=yuv420p[v${index}]`,
    );
    labels.push(`[v${index}]`);
    if (anyAudio) {
      const duration = seconds(clip.durationSeconds);
      parts.push(
        clip.hasAudio
          ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration}[a${index}]`
          : `anullsrc=r=48000:cl=stereo:d=${duration},aformat=sample_fmts=fltp[a${index}]`,
      );
      labels.push(`[a${index}]`);
    }
  });
  parts.push(
    `${labels.join("")}concat=n=${input.clips.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? "[a]" : ""}`,
  );
  return [
    ...BASE_ARGS,
    ...input.clips.flatMap((clip) => guardedInput(clip.filePath)),
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[v]",
    ...(anyAudio ? ["-map", "[a]"] : []),
    ...VIDEO_OUTPUT_ARGS,
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

/**
 * Crop scales up until the shape is covered and cuts the overflow evenly from both sides. Pad
 * keeps the whole picture and fills the rest with a blurred, enlarged copy of itself.
 */
export function buildResizeFilter(shape: PlatformShape, fit: ResizeFit): string {
  const { width, height } = PLATFORM_SHAPES[shape];
  const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  if (fit === "crop") return `${cover},setsar=1`;
  return (
    `split[a][b];[a]${cover},boxblur=24:6[bg];` +
    `[b]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`
  );
}

export function buildResizeArgs(input: {
  readonly kind: "video" | "image";
  readonly filePath: string;
  readonly shape: PlatformShape;
  readonly fit: ResizeFit;
  readonly outputPath: string;
}): string[] {
  const filter = buildResizeFilter(input.shape, input.fit);
  if (input.kind === "image") {
    return [
      ...BASE_ARGS,
      ...guardedInput(input.filePath),
      "-frames:v",
      "1",
      "-vf",
      filter,
      "-q:v",
      "2",
      ...sizeLimitArgs,
      input.outputPath,
    ];
  }
  return [
    ...BASE_ARGS,
    ...guardedInput(input.filePath),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `${filter},format=yuv420p`,
    ...VIDEO_OUTPUT_ARGS,
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

/** The name the captions file gets in the cache folder. Only these characters ever reach a filter. */
const SAFE_FILTER_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeFilterFileName(name: string): boolean {
  return SAFE_FILTER_FILE_NAME.test(name);
}

/**
 * ffmpeg is run with the cache folder as its working folder and told the captions file's bare
 * name, so no path (and none of a path's colons, quotes or backslashes) is in the filter string.
 * A name outside the safe set is refused rather than escaped.
 */
export function buildCaptionsFilter(captionsFileName: string): string {
  if (!isSafeFilterFileName(captionsFileName)) {
    throw new Error("The captions file name is not safe to put in a filter.");
  }
  return `${EVEN_SIZE_FILTER},subtitles=filename=${captionsFileName}`;
}

export function buildCaptionsArgs(input: {
  readonly filePath: string;
  readonly captionsFileName: string;
  readonly outputPath: string;
}): string[] {
  return [
    ...BASE_ARGS,
    ...guardedInput(input.filePath),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    buildCaptionsFilter(input.captionsFileName),
    ...VIDEO_OUTPUT_ARGS,
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

/** Video can be copied as it is when an mp4 holds it without a re-encode. */
export function canCopyVideoIntoMp4(codec: string | null, extension: string): boolean {
  return (
    (codec === "h264" || codec === "hevc") &&
    [".mp4", ".mov", ".m4v"].includes(extension.toLowerCase())
  );
}

export function buildMuteArgs(input: {
  readonly filePath: string;
  readonly copyVideo: boolean;
  readonly outputPath: string;
}): string[] {
  return [
    ...BASE_ARGS,
    ...guardedInput(input.filePath),
    "-map",
    "0:v:0",
    "-an",
    ...(input.copyVideo
      ? ["-c:v", "copy", ...FAST_START_ARGS]
      : ["-vf", EVEN_SIZE_FILTER, ...H264_ARGS, ...FAST_START_ARGS]),
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

export function buildExtractAudioArgs(input: {
  readonly filePath: string;
  readonly outputPath: string;
}): string[] {
  return [
    ...BASE_ARGS,
    ...guardedInput(input.filePath),
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    ...FAST_START_ARGS,
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

export function buildPosterArgs(input: {
  readonly filePath: string;
  readonly at: number;
  readonly outputPath: string;
}): string[] {
  return [
    ...BASE_ARGS,
    "-ss",
    seconds(input.at),
    ...guardedInput(input.filePath),
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-f",
    "image2",
    ...sizeLimitArgs,
    input.outputPath,
  ];
}

/** Text becomes one plain ASS line: no override blocks, no escapes, newlines kept as breaks. */
export function sanitizeCaptionText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "")
        .replace(/\\/g, "/")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\\N");
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `h:mm:ss.cc`, the only time format ASS reads. */
export function assTime(totalSeconds: number): string {
  const centis = Math.round(Math.max(0, totalSeconds) * 100);
  const hours = Math.floor(centis / 360_000);
  const minutes = Math.floor((centis % 360_000) / 6_000);
  const secs = Math.floor((centis % 6_000) / 100);
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis % 100)}`;
}

/**
 * The captions as an ASS script sized to the picture, so type scales with it: white with a black
 * outline, bottom centre, wrapped inside side margins.
 */
export function buildAss(input: {
  readonly width: number;
  readonly height: number;
  readonly captions: ReadonlyArray<Caption>;
}): string {
  const { width, height } = input;
  const fontSize = Math.max(12, Math.round(Math.min(width, height) * 0.06));
  const outline = Math.max(2, Math.round(fontSize * 0.1));
  const marginSide = Math.round(width * 0.05);
  const marginBottom = Math.round(height * 0.06);
  const lines = input.captions.flatMap((caption) => {
    const text = sanitizeCaptionText(caption.text);
    return text === ""
      ? []
      : [`Dialogue: 0,${assTime(caption.start)},${assTime(caption.end)},Default,,0,0,0,,${text}`];
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${marginSide},${marginSide},${marginBottom},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}
