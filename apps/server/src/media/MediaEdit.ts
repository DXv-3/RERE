/**
 * MediaEdit - makes a new video, image or audio file from an existing one with ffmpeg.
 *
 * One operation per call: trim, join, resize to a platform shape, burn in captions, mute, pull
 * out the audio, or save a still. The result is always a NEW file beside the first input
 * (`<name>.<operation>-<n>.<ext>`); nothing is ever overwritten. Paths, size and length limits,
 * the ffmpeg input guard and the job limit are the ones `MediaService` uses for looking at files.
 *
 * @module MediaEdit
 */
import { MediaError, type MediaErrorReason, type MediaProbe } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  buildCaptionsArgs,
  buildExtractAudioArgs,
  buildJoinArgs,
  buildMuteArgs,
  buildPosterArgs,
  buildResizeArgs,
  buildTrimArgs,
  buildAss,
  canCopyVideoIntoMp4,
  joinFrameRate,
  MEDIA_EDIT_CAPTION_TEXT_MAX,
  MEDIA_EDIT_CAPTIONS_MAX,
  MEDIA_EDIT_JOIN_MAX,
  MEDIA_EDIT_JOIN_MIN,
  MEDIA_EDIT_MAX_OUTPUT_BYTES,
  PLATFORM_SHAPE_NAMES,
  type Caption,
  type MediaEditOperation,
  type PlatformShape,
  type ResizeFit,
} from "./MediaEditFfmpeg.ts";
import * as MediaService from "./MediaService.ts";
import { buildProbeArgs, clampTimestamp } from "./mediaFfmpeg.ts";

const INSTALL_HINT =
  "Install ffmpeg (for example `brew install ffmpeg` or `apt install ffmpeg`) on the machine running the server, then try again.";
/** Re-encoding is slower than looking: a minute plus three seconds per second of picture. */
const TIMEOUT_BASE_SECONDS = 60;
const TIMEOUT_PER_MEDIA_SECOND = 3;
const TIMEOUT_CEILING_SECONDS = 30 * 60;
const OUTPUT_NUMBER_LIMIT = 999;

const fail = (reason: MediaErrorReason, message: string) => new MediaError({ reason, message });
const invalid = (message: string) => fail("invalid_request", message);

/** What a caller asks for. `file` and `files` are relative to the thread's folder. */
export type MediaEditRequest =
  | {
      readonly operation: "trim";
      readonly file: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly operation: "join"; readonly files: ReadonlyArray<string> }
  | {
      readonly operation: "resize";
      readonly file: string;
      readonly shape: PlatformShape;
      readonly fit: ResizeFit;
    }
  | {
      readonly operation: "captions";
      readonly file: string;
      readonly captions: ReadonlyArray<Caption>;
    }
  | { readonly operation: "mute"; readonly file: string }
  | { readonly operation: "extract-audio"; readonly file: string }
  | { readonly operation: "poster"; readonly file: string; readonly at: number };

/** The loose, flat shape a tool call arrives in. */
export interface MediaEditParameters {
  readonly operation: MediaEditOperation;
  readonly file?: string | undefined;
  readonly files?: ReadonlyArray<string> | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly shape?: PlatformShape | undefined;
  readonly fit?: ResizeFit | undefined;
  readonly captions?: ReadonlyArray<Caption> | undefined;
  readonly at?: number | undefined;
}

const finite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value);

export type ParsedEditRequest =
  | { readonly request: MediaEditRequest }
  | { readonly error: MediaError };

const bad = (message: string): ParsedEditRequest => ({ error: invalid(message) });

/** Checks that each operation got the parameters it needs, in words a caller can act on. */
export function toEditRequest(input: MediaEditParameters): ParsedEditRequest {
  if (input.operation === "join") {
    const files = input.files ?? [];
    if (files.length < MEDIA_EDIT_JOIN_MIN || files.length > MEDIA_EDIT_JOIN_MAX) {
      return bad(`join needs ${MEDIA_EDIT_JOIN_MIN} to ${MEDIA_EDIT_JOIN_MAX} files, in order.`);
    }
    return { request: { operation: "join", files } };
  }
  const file = input.file;
  if (file === undefined || file.trim() === "") return bad(`${input.operation} needs file.`);
  switch (input.operation) {
    case "trim": {
      if (
        !finite(input.start) ||
        !finite(input.end) ||
        input.start < 0 ||
        input.end <= input.start
      ) {
        return bad("trim needs start and end in seconds, with end after start.");
      }
      return { request: { operation: "trim", file, start: input.start, end: input.end } };
    }
    case "resize": {
      if (input.shape === undefined || !PLATFORM_SHAPE_NAMES.includes(input.shape)) {
        return bad(`resize needs shape: ${PLATFORM_SHAPE_NAMES.join(", ")}.`);
      }
      return {
        request: { operation: "resize", file, shape: input.shape, fit: input.fit ?? "crop" },
      };
    }
    case "captions": {
      const captions = input.captions ?? [];
      if (captions.length === 0 || captions.length > MEDIA_EDIT_CAPTIONS_MAX) {
        return bad(`captions needs 1 to ${MEDIA_EDIT_CAPTIONS_MAX} entries.`);
      }
      for (const caption of captions) {
        if (
          !finite(caption.start) ||
          !finite(caption.end) ||
          caption.start < 0 ||
          caption.end <= caption.start
        ) {
          return bad("Every caption needs a start and an end in seconds, with end after start.");
        }
        if (caption.text.trim() === "" || caption.text.length > MEDIA_EDIT_CAPTION_TEXT_MAX) {
          return bad(`Every caption needs text of 1 to ${MEDIA_EDIT_CAPTION_TEXT_MAX} characters.`);
        }
      }
      return { request: { operation: "captions", file, captions } };
    }
    case "poster": {
      if (!finite(input.at) || input.at < 0) return bad("poster needs at, in seconds.");
      return { request: { operation: "poster", file, at: input.at } };
    }
    case "mute":
      return { request: { operation: "mute", file } };
    case "extract-audio":
      return { request: { operation: "extract-audio", file } };
  }
}

export interface MediaEditResult {
  readonly operation: MediaEditOperation;
  /** The new file, relative to the thread's folder. */
  readonly file: string;
  /** Facts about the new picture or video. Null for audio, which `audio` describes instead. */
  readonly probe: MediaProbe | null;
  readonly audio: { readonly durationSeconds: number | null; readonly sizeBytes: number } | null;
  /** True when the picture was decoded and encoded again, which loses a little quality. */
  readonly reencoded: boolean;
  readonly notes: ReadonlyArray<string>;
}

export class MediaEdit extends Context.Service<
  MediaEdit,
  {
    /** Makes one new file from the request, beside its first input, and says what it made. */
    readonly edit: (
      cwd: string,
      request: MediaEditRequest,
    ) => Effect.Effect<MediaEditResult, MediaError>;
  }
>()("t3/media/MediaEdit") {}

interface Source {
  readonly resolved: MediaService.ResolvedMediaFile;
  readonly probe: MediaProbe;
  readonly relativePath: string;
}

const make = Effect.gen(function* () {
  const media = yield* MediaService.MediaService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const cacheDir = path.join(config.stateDir, "media-cache");

  const source = Effect.fn("MediaEdit.source")(function* (cwd: string, relativePath: string) {
    // The probe also applies the length limit; resolving applies the path and size limits.
    const probe = yield* media.probe({ cwd, relativePath });
    const resolved = yield* media.resolveFile({ cwd, relativePath });
    return { resolved, probe, relativePath } satisfies Source;
  });

  const needVideo = (item: Source) =>
    item.resolved.kind === "video"
      ? Effect.void
      : Effect.fail(invalid(`${item.relativePath} is not a video.`));

  /** The first name `<stem>.<operation>-<n>.<ext>` that is free, inside the folder. */
  const freeOutputPath = Effect.fn("MediaEdit.freeOutputPath")(function* (
    first: Source,
    operation: MediaEditOperation,
    extension: string,
  ) {
    const directory = path.dirname(first.resolved.realPath);
    const stem = path.basename(first.resolved.realPath, path.extname(first.resolved.realPath));
    for (let number = 1; number <= OUTPUT_NUMBER_LIMIT; number += 1) {
      const candidate = path.join(directory, `${stem}.${operation}-${number}${extension}`);
      const relative = path.relative(first.resolved.realRoot, candidate);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* fail(
          "outside_workspace",
          "The new file would be outside the thread's folder.",
        );
      }
      const taken = yield* fileSystem
        .exists(candidate)
        .pipe(Effect.mapError(() => fail("tool_failed", "Could not check for an existing file.")));
      if (!taken) return { outputPath: candidate, relative };
    }
    return yield* fail("tool_failed", "There are too many edited copies of this file already.");
  });

  const timeoutFor = (mediaSeconds: number) =>
    Duration.seconds(
      Math.min(
        TIMEOUT_CEILING_SECONDS,
        Math.ceil(TIMEOUT_BASE_SECONDS + TIMEOUT_PER_MEDIA_SECOND * Math.max(0, mediaSeconds)),
      ),
    );

  const runFfmpeg = (args: ReadonlyArray<string>, timeout: Duration.Duration, cwd?: string) =>
    media
      .withJobSlot(
        runner.run({
          command: "ffmpeg",
          args,
          timeout,
          maxOutputBytes: 1024 * 1024,
          ...(cwd === undefined ? {} : { cwd }),
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (error._tag === "ProcessSpawnError") {
            return fail("tool_missing", `ffmpeg is not installed. ${INSTALL_HINT}`);
          }
          if (error._tag === "ProcessTimeoutError") {
            return fail("timeout", "ffmpeg took too long to make the new file.");
          }
          return fail("tool_failed", "ffmpeg could not make the new file.");
        }),
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.void
            : Effect.fail(
                fail("tool_failed", "ffmpeg could not make the new file from these inputs."),
              ),
        ),
      );

  /** The length of an audio file we just wrote, or null when ffprobe cannot say. */
  const audioDuration = (filePath: string) =>
    media
      .withJobSlot(
        runner.run({
          command: "ffprobe",
          args: buildProbeArgs(filePath),
          timeout: Duration.seconds(15),
          maxOutputBytes: 1024 * 1024,
        }),
      )
      .pipe(
        Effect.map((output) => {
          try {
            const seconds = Number(
              (JSON.parse(output.stdout) as { format?: { duration?: string } }).format?.duration,
            );
            return Number.isFinite(seconds) ? seconds : null;
          } catch {
            return null;
          }
        }),
        Effect.orElseSucceed(() => null),
      );

  const removeQuietly = (target: string) =>
    fileSystem.remove(target, { force: true }).pipe(Effect.ignore);

  /** Runs one ffmpeg job to a free name, checks what came out, and removes it if it is no good. */
  const produce = Effect.fn("MediaEdit.produce")(function* (input: {
    readonly cwd: string;
    readonly first: Source;
    readonly operation: MediaEditOperation;
    readonly extension: string;
    readonly mediaSeconds: number;
    readonly args: (outputPath: string) => ReadonlyArray<string>;
    readonly spawnCwd?: string;
    readonly reencoded: boolean;
    readonly notes: ReadonlyArray<string>;
  }) {
    const { outputPath, relative } = yield* freeOutputPath(
      input.first,
      input.operation,
      input.extension,
    );
    const built = yield* runFfmpeg(
      input.args(outputPath),
      timeoutFor(input.mediaSeconds),
      input.spawnCwd,
    ).pipe(
      Effect.tapError(() => removeQuietly(outputPath)),
      Effect.exit,
    );
    if (built._tag === "Failure") {
      yield* removeQuietly(outputPath);
      return yield* Effect.failCause(built.cause);
    }
    const info = yield* fileSystem
      .stat(outputPath)
      .pipe(Effect.mapError(() => fail("tool_failed", "ffmpeg produced no file.")));
    const size = Number(info.size);
    if (size <= 0 || size >= MEDIA_EDIT_MAX_OUTPUT_BYTES) {
      yield* removeQuietly(outputPath);
      return yield* size <= 0
        ? fail("tool_failed", "ffmpeg produced an empty file.")
        : fail("too_large", "The new file would be over 2 GB, so it was not kept.");
    }
    const isAudio = input.extension === ".m4a";
    const probe = isAudio
      ? null
      : yield* media
          .probe({ cwd: input.cwd, relativePath: relative })
          .pipe(Effect.tapError(() => removeQuietly(outputPath)));
    const audio = isAudio
      ? { durationSeconds: yield* audioDuration(outputPath), sizeBytes: size }
      : null;
    return {
      operation: input.operation,
      file: relative,
      probe,
      audio,
      reencoded: input.reencoded,
      notes: input.notes,
    } satisfies MediaEditResult;
  });

  const durationOf = (item: Source) => item.probe.durationSeconds ?? 0;

  const edit: MediaEdit["Service"]["edit"] = Effect.fn("MediaEdit.edit")(function* (cwd, request) {
    switch (request.operation) {
      case "trim": {
        const item = yield* source(cwd, request.file);
        yield* needVideo(item);
        const duration = durationOf(item);
        if (request.start >= duration) {
          return yield* invalid(
            `start is past the end of ${request.file}, which is ${duration.toFixed(1)} seconds long.`,
          );
        }
        const end = Math.min(request.end, duration);
        return yield* produce({
          cwd,
          first: item,
          operation: "trim",
          extension: ".mp4",
          mediaSeconds: end - request.start,
          args: (outputPath) =>
            buildTrimArgs({
              filePath: item.resolved.realPath,
              start: request.start,
              end,
              outputPath,
            }),
          reencoded: true,
          notes: [
            "Re-encoded to H.264 so the cut lands on the exact frame.",
            ...(end < request.end
              ? [`end was past the clip, so it was cut at ${end.toFixed(2)} seconds.`]
              : []),
          ],
        });
      }
      case "join": {
        const items = yield* Effect.forEach(request.files, (file) => source(cwd, file));
        yield* Effect.forEach(items, needVideo);
        const total = items.reduce((sum, item) => sum + durationOf(item), 0);
        const [first] = items;
        if (first === undefined) return yield* invalid("join needs files.");
        return yield* produce({
          cwd,
          first,
          operation: "join",
          extension: ".mp4",
          mediaSeconds: total,
          args: (outputPath) =>
            buildJoinArgs({
              clips: items.map((item) => ({
                filePath: item.resolved.realPath,
                durationSeconds: durationOf(item),
                hasAudio: item.probe.hasAudio,
              })),
              width: first.probe.width,
              height: first.probe.height,
              fps: joinFrameRate(first.probe.fps),
              outputPath,
            }),
          reencoded: true,
          notes: [
            `Re-encoded: every clip was fitted to ${first.probe.width}x${first.probe.height} (black bars, never stretched) and one frame rate so clips from different sources play together.`,
          ],
        });
      }
      case "resize": {
        const item = yield* source(cwd, request.file);
        const isVideo = item.resolved.kind === "video";
        return yield* produce({
          cwd,
          first: item,
          operation: "resize",
          extension: isVideo ? ".mp4" : path.extname(item.resolved.realPath).toLowerCase(),
          mediaSeconds: isVideo ? durationOf(item) : 0,
          args: (outputPath) =>
            buildResizeArgs({
              kind: item.resolved.kind,
              filePath: item.resolved.realPath,
              shape: request.shape,
              fit: request.fit,
              outputPath,
            }),
          reencoded: true,
          notes: [
            request.fit === "crop"
              ? "Cropped from the centre to fill the shape."
              : "Fitted whole inside the shape; the rest is filled with a blurred copy of the picture.",
          ],
        });
      }
      case "captions": {
        const item = yield* source(cwd, request.file);
        yield* needVideo(item);
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => fail("tool_failed", "Could not prepare the captions.")),
        );
        const captionsFileName = `captions-${Encoding.encodeHex(new TextEncoder().encode(token))}.ass`;
        const captionsPath = path.join(cacheDir, captionsFileName);
        yield* fileSystem.makeDirectory(cacheDir, { recursive: true }).pipe(
          Effect.andThen(
            fileSystem.writeFileString(
              captionsPath,
              buildAss({
                width: item.probe.width,
                height: item.probe.height,
                captions: request.captions,
              }),
            ),
          ),
          Effect.mapError(() => fail("tool_failed", "Could not prepare the captions.")),
        );
        return yield* produce({
          cwd,
          first: item,
          operation: "captions",
          extension: ".mp4",
          mediaSeconds: durationOf(item),
          spawnCwd: cacheDir,
          args: (outputPath) =>
            buildCaptionsArgs({
              filePath: item.resolved.realPath,
              captionsFileName,
              outputPath,
            }),
          reencoded: true,
          notes: [
            "Captions are burned into the picture, white with a dark outline at the bottom centre. Curly braces in the text were shown as parentheses and backslashes as slashes.",
          ],
        }).pipe(Effect.ensuring(removeQuietly(captionsPath)));
      }
      case "mute": {
        const item = yield* source(cwd, request.file);
        yield* needVideo(item);
        const copyVideo = canCopyVideoIntoMp4(
          item.probe.codec,
          path.extname(item.resolved.realPath),
        );
        return yield* produce({
          cwd,
          first: item,
          operation: "mute",
          extension: ".mp4",
          mediaSeconds: copyVideo ? 0 : durationOf(item),
          args: (outputPath) =>
            buildMuteArgs({ filePath: item.resolved.realPath, copyVideo, outputPath }),
          reencoded: !copyVideo,
          notes: [copyVideo ? "The picture was copied as it is." : "Re-encoded to H.264."],
        });
      }
      case "extract-audio": {
        const item = yield* source(cwd, request.file);
        yield* needVideo(item);
        if (!item.probe.hasAudio) {
          return yield* invalid(`${request.file} has no sound to extract.`);
        }
        return yield* produce({
          cwd,
          first: item,
          operation: "extract-audio",
          extension: ".m4a",
          mediaSeconds: durationOf(item),
          args: (outputPath) =>
            buildExtractAudioArgs({ filePath: item.resolved.realPath, outputPath }),
          reencoded: true,
          notes: ["The sound was encoded as AAC in an m4a file."],
        });
      }
      case "poster": {
        const item = yield* source(cwd, request.file);
        yield* needVideo(item);
        const at = clampTimestamp(request.at, item.probe.durationSeconds, item.probe.fps);
        return yield* produce({
          cwd,
          first: item,
          operation: "poster",
          extension: ".jpg",
          mediaSeconds: 0,
          args: (outputPath) =>
            buildPosterArgs({ filePath: item.resolved.realPath, at, outputPath }),
          reencoded: true,
          notes: [`The still is from ${at.toFixed(2)} seconds.`],
        });
      }
    }
  });

  return MediaEdit.of({ edit });
});

export const layer = Layer.effect(MediaEdit, make);
