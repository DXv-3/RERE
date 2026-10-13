/**
 * MediaService - looks inside video and image files with ffprobe and ffmpeg.
 *
 * Serves the media viewer (timeline thumbnails), the annotate flow (frames with the circled box
 * drawn on them) and the `media_inspect` agent tool from one place. Files must resolve inside
 * the caller's workspace root, symlinks included. Derived frames are cached on disk under the
 * server state directory, keyed by the file's real path, size, modification time and the request.
 *
 * @module MediaService
 */
import {
  MEDIA_FRAME_DEFAULT_EDGE,
  MediaError,
  type MediaErrorReason,
  type MediaFrame,
  type MediaFramesInput,
  type MediaFramesResult,
  type MediaKind,
  type MediaProbe,
  type MediaProbeInput,
  type MediaThumbnailsInput,
  type MediaThumbnailsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  buildFrameArgs,
  buildFrameFilter,
  buildProbeArgs,
  clampEdge,
  clampTimestamp,
  evenlySpacedTimestamps,
  MEDIA_MAX_DURATION_SECONDS,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_VIDEO_BYTES,
  mediaKindFromExtension,
  parseProbeJson,
  roundTimestamp,
  scaledFrameSize,
  THUMBNAIL_EDGE,
} from "./mediaFfmpeg.ts";

const PROBE_TIMEOUT = "15 seconds";
const FRAME_TIMEOUT = "30 seconds";
const MAX_CONCURRENT_JOBS = 3;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const INSTALL_HINT =
  "Install ffmpeg (for example `brew install ffmpeg` or `apt install ffmpeg`) on the machine running the server, then try again.";

const boxKey = (box: MediaFramesInput["box"]) =>
  box ? `${box.x},${box.y},${box.width},${box.height}` : "none";

const fail = (reason: MediaErrorReason, message: string) => new MediaError({ reason, message });

export class MediaService extends Context.Service<
  MediaService,
  {
    /** Facts about the file: duration, size, frame rate, audio, codec. */
    readonly probe: (input: MediaProbeInput) => Effect.Effect<MediaProbe, MediaError>;
    /** Still frames at the given seconds, optionally with a rectangle drawn on each. */
    readonly frames: (input: MediaFramesInput) => Effect.Effect<MediaFramesResult, MediaError>;
    /** Small evenly spaced frames for a timeline strip. */
    readonly thumbnails: (
      input: MediaThumbnailsInput,
    ) => Effect.Effect<MediaThumbnailsResult, MediaError>;
    /** For `MediaEdit`: the same path checks every read goes through. */
    readonly resolveFile: (input: MediaProbeInput) => Effect.Effect<ResolvedMediaFile, MediaError>;
    /** For `MediaEdit`: runs a job under the one limit that keeps ffmpeg from swamping the machine. */
    readonly withJobSlot: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/media/MediaService") {}

export interface ResolvedMediaFile {
  /** The workspace folder with symlinks resolved; `realPath` is inside it. */
  readonly realRoot: string;
  readonly realPath: string;
  readonly kind: MediaKind;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const runner = yield* ProcessRunner.ProcessRunner;
  const jobs = yield* Semaphore.make(MAX_CONCURRENT_JOBS);
  const cacheDir = path.join(config.stateDir, "media-cache");

  // Old derived files are only a cache; clear them once per process, never on a request.
  yield* Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(cacheDir);
    const cutoff = (yield* Clock.currentTimeMillis) - CACHE_MAX_AGE_MS;
    yield* Effect.forEach(
      names,
      (name) =>
        fileSystem
          .stat(path.join(cacheDir, name))
          .pipe(
            Effect.flatMap((info) =>
              info.mtime._tag === "Some" && info.mtime.value.getTime() < cutoff
                ? fileSystem.remove(path.join(cacheDir, name), { force: true })
                : Effect.void,
            ),
          ),
      { concurrency: 4, discard: true },
    );
  }).pipe(Effect.ignore, Effect.forkDetach);

  const resolveFile = Effect.fn("MediaService.resolveFile")(function* (input: MediaProbeInput) {
    const root = yield* workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(Effect.mapError(() => fail("not_found", "The thread's folder is not available.")));
    const target = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: root, relativePath: input.relativePath })
      .pipe(
        Effect.mapError(() =>
          fail("outside_workspace", "Media files must be inside the thread's folder."),
        ),
      );
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError(() => fail("not_found", "The thread's folder is not available.")));
    const realPath = yield* fileSystem
      .realPath(target.absolutePath)
      .pipe(Effect.mapError(() => fail("not_found", `${input.relativePath} was not found.`)));
    const relative = path.relative(realRoot, realPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* fail("outside_workspace", "Media files must be inside the thread's folder.");
    }
    const info = yield* fileSystem
      .stat(realPath)
      .pipe(Effect.mapError(() => fail("not_found", `${input.relativePath} was not found.`)));
    if (info.type !== "File") {
      return yield* fail("not_found", `${input.relativePath} is not a file.`);
    }
    const kind = mediaKindFromExtension(path.extname(realPath));
    if (kind === null) {
      return yield* fail(
        "unsupported_type",
        "Only mp4, mov, m4v, webm, mkv, png, jpg, webp and gif files can be inspected.",
      );
    }
    const sizeBytes = Number(info.size);
    if (sizeBytes > (kind === "video" ? MEDIA_MAX_VIDEO_BYTES : MEDIA_MAX_IMAGE_BYTES)) {
      return yield* fail("too_large", `${input.relativePath} is too large to inspect.`);
    }
    return {
      realRoot,
      realPath,
      kind,
      sizeBytes,
      mtimeMs: info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0,
    } satisfies ResolvedMediaFile;
  });

  const cachePathFor = Effect.fn("MediaService.cachePathFor")(function* (
    file: ResolvedMediaFile,
    variant: ReadonlyArray<string | number>,
    extension: string,
  ) {
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          [file.realPath, file.sizeBytes, file.mtimeMs, ...variant].join("\u0000"),
        ),
      )
      .pipe(Effect.mapError(() => fail("tool_failed", "Could not prepare the media cache.")));
    return path.join(cacheDir, `${Encoding.encodeHex(digest)}${extension}`);
  });

  /** Runs one tool under the shared job limit. A missing executable names the fix. */
  const runTool = Effect.fn("MediaService.runTool")(function* (
    command: "ffprobe" | "ffmpeg",
    args: ReadonlyArray<string>,
    timeout: Duration.Input,
  ) {
    const output = yield* jobs
      .withPermits(1)(runner.run({ command, args, timeout, maxOutputBytes: 4 * 1024 * 1024 }))
      .pipe(
        Effect.mapError((error) => {
          if (error._tag === "ProcessSpawnError") {
            return fail("tool_missing", `${command} is not installed. ${INSTALL_HINT}`);
          }
          if (error._tag === "ProcessTimeoutError") {
            return fail("timeout", `${command} took too long on this file.`);
          }
          return fail("tool_failed", `${command} could not read this file.`);
        }),
      );
    if (output.code !== 0) {
      return yield* fail("tool_failed", `${command} could not read this file.`);
    }
    return output;
  });

  const probeResolved = Effect.fn("MediaService.probeResolved")(function* (
    file: ResolvedMediaFile,
  ) {
    const cachePath = yield* cachePathFor(file, ["probe"], ".probe.json");
    const cached = yield* fileSystem.readFileString(cachePath).pipe(Effect.option);
    if (cached._tag === "Some") {
      const parsed = parseProbeJson(cached.value, file.kind, file.sizeBytes);
      if (parsed) return parsed;
    }
    const output = yield* runTool("ffprobe", buildProbeArgs(file.realPath), PROBE_TIMEOUT);
    const probe = parseProbeJson(output.stdout, file.kind, file.sizeBytes);
    if (!probe) return yield* fail("tool_failed", "ffprobe found no picture in this file.");
    yield* fileSystem
      .makeDirectory(cacheDir, { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(cachePath, output.stdout)), Effect.ignore);
    return probe;
  });

  const probeChecked = Effect.fn("MediaService.probeChecked")(function* (input: MediaProbeInput) {
    const file = yield* resolveFile(input);
    const probe = yield* probeResolved(file);
    if (probe.durationSeconds !== null && probe.durationSeconds > MEDIA_MAX_DURATION_SECONDS) {
      return yield* fail("too_long", `${input.relativePath} is too long to inspect.`);
    }
    return { file, probe };
  });

  const renderFrame = Effect.fn("MediaService.renderFrame")(function* (input: {
    readonly file: ResolvedMediaFile;
    readonly probe: MediaProbe;
    readonly seconds: number;
    readonly maxEdge: number;
    readonly box?: MediaFramesInput["box"];
    readonly timeout: Duration.Input;
  }) {
    const seconds = roundTimestamp(
      clampTimestamp(input.seconds, input.probe.durationSeconds, input.probe.fps),
    );
    const outputPath = yield* cachePathFor(
      input.file,
      ["frame", seconds, input.maxEdge, boxKey(input.box)],
      ".jpg",
    );
    const hit = yield* fileSystem.readFile(outputPath).pipe(Effect.option);
    const bytes =
      hit._tag === "Some"
        ? hit.value
        : yield* Effect.gen(function* () {
            yield* fileSystem
              .makeDirectory(cacheDir, { recursive: true })
              .pipe(
                Effect.mapError(() => fail("tool_failed", "Could not prepare the media cache.")),
              );
            // Write beside the final name and rename, so a half-written frame is never served.
            const token = yield* crypto.randomUUIDv4.pipe(
              Effect.mapError(() => fail("tool_failed", "Could not prepare the media cache.")),
            );
            const partialPath = `${outputPath}.${token}.part.jpg`;
            const extract = (at: number) =>
              runTool(
                "ffmpeg",
                buildFrameArgs({
                  kind: input.file.kind,
                  filePath: input.file.realPath,
                  seconds: at,
                  filter: buildFrameFilter({ maxEdge: input.maxEdge, box: input.box }),
                  outputPath: partialPath,
                }),
                input.timeout,
              );
            yield* extract(seconds);
            // A seek into the last moments can decode nothing; one earlier try finds a frame.
            if (!(yield* fileSystem.exists(partialPath).pipe(Effect.orElseSucceed(() => false)))) {
              yield* extract(Math.max(0, seconds - 1));
            }
            yield* fileSystem
              .rename(partialPath, outputPath)
              .pipe(Effect.mapError(() => fail("tool_failed", "Could not store the frame.")));
            return yield* fileSystem
              .readFile(outputPath)
              .pipe(Effect.mapError(() => fail("tool_failed", "ffmpeg produced no frame.")));
          });
    const size = scaledFrameSize(input.probe.width, input.probe.height, input.maxEdge);
    return {
      at: seconds,
      mimeType: "image/jpeg" as const,
      base64: Encoding.encodeBase64(bytes),
      ...size,
    } satisfies MediaFrame;
  });

  const probe: MediaService["Service"]["probe"] = (input) =>
    probeChecked(input).pipe(Effect.map((result) => result.probe));

  const frames: MediaService["Service"]["frames"] = Effect.fn("MediaService.frames")(
    function* (input) {
      const { file, probe: facts } = yield* probeChecked(input);
      const maxEdge = clampEdge(input.maxEdge, MEDIA_FRAME_DEFAULT_EDGE);
      const rendered = yield* Effect.forEach(
        input.at,
        (seconds) =>
          renderFrame({
            file,
            probe: facts,
            seconds,
            maxEdge,
            box: input.box,
            timeout: FRAME_TIMEOUT,
          }),
        { concurrency: MAX_CONCURRENT_JOBS },
      );
      return { probe: facts, frames: rendered };
    },
  );

  const thumbnails: MediaService["Service"]["thumbnails"] = Effect.fn("MediaService.thumbnails")(
    function* (input) {
      const { file, probe: facts } = yield* probeChecked(input);
      const moments = evenlySpacedTimestamps(input.count, facts.durationSeconds, facts.fps);
      const rendered = yield* Effect.forEach(
        file.kind === "image" ? moments.slice(0, 1) : moments,
        (seconds) =>
          renderFrame({
            file,
            probe: facts,
            seconds,
            maxEdge: THUMBNAIL_EDGE,
            timeout: FRAME_TIMEOUT,
          }),
        { concurrency: MAX_CONCURRENT_JOBS },
      );
      return { frames: rendered };
    },
  );

  return MediaService.of({
    probe,
    frames,
    thumbnails,
    resolveFile,
    withJobSlot: (effect) => jobs.withPermits(1)(effect),
  });
});

export const layer = Layer.effect(MediaService, make);
