import { type MediaError, type MediaProbe } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as MediaService from "../../media/MediaService.ts";
import {
  buildAss,
  PLATFORM_SHAPES,
  type Caption,
  type ResizeFit,
  MEDIA_EDIT_MAX_OUTPUT_BYTES,
} from "../../media/MediaEditFfmpeg.ts";
import { buildStudioArgs, STUDIO_AUDIO_INPUT_ARGS } from "../../media/MediaEditStudio.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";

export class StudioMediaError extends Schema.TaggedError<StudioMediaError>()("StudioMediaError", {
  reason: Schema.Literals(["invalid_input", "not_configured", "provider", "storage", "render"]),
}) {
  override get message() {
    return {
      invalid_input: "Check the scene ranges, caption lengths and workspace media paths.",
      not_configured: "Configure an ElevenLabs key in voice settings before generating narration.",
      provider:
        "Narration could not be saved. The provider request may have been billed; it was not retried.",
      storage: "The workspace output folder could not be read or written.",
      render:
        "Local media assembly failed. Check that ffmpeg is available and the inputs are playable.",
    }[this.reason];
  }
}

const shapes = {
  "9:16": "vertical",
  "16:9": "landscape",
  "1:1": "square",
  "4:5": "portrait-4x5",
} as const;
export interface StudioRenderInput {
  readonly cwd: string;
  readonly scenes: ReadonlyArray<{
    readonly file: string;
    readonly start?: number;
    readonly durationSeconds: number;
    readonly onScreenText?: string;
    readonly captions?: ReadonlyArray<Caption>;
  }>;
  readonly aspectRatio: keyof typeof shapes;
  readonly fit?: ResizeFit;
  readonly audioFile?: string;
  readonly keepSourceAudio?: boolean;
}
interface NarrationInput {
  readonly cwd: string;
  readonly text: string;
  readonly voiceId?: string;
}

export class StudioMedia extends Context.Service<
  StudioMedia,
  {
    readonly render: (
      input: StudioRenderInput,
    ) => Effect.Effect<
      { readonly file: string; readonly probe: MediaProbe },
      StudioMediaError | MediaError
    >;
    /** Read-only local validation before reserving spend. Never calls the provider or returns credentials. */
    readonly checkNarration: (input: NarrationInput) => Effect.Effect<void, StudioMediaError>;
    /** Bills ElevenLabs. The caller must obtain approval before invoking; never automatically retry. */
    readonly narration: (
      input: NarrationInput,
    ) => Effect.Effect<
      { readonly file: string; readonly providerRequestId?: string | null },
      StudioMediaError
    >;
  }
>()("t3/campaigns/studio/StudioMedia") {}

const make = Effect.gen(function* () {
  const media = yield* MediaService.MediaService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const runner = yield* ProcessRunner.ProcessRunner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const narrationJobs = yield* Semaphore.make(2);
  const failure = (reason: StudioMediaError["reason"]) => new StudioMediaError({ reason });
  const rootOf = Effect.fn(
    function* (cwd: string) {
      const root = yield* paths.normalizeWorkspaceRoot(cwd);
      return yield* fs.realPath(root);
    },
    Effect.mapError(() => failure("storage")),
  );
  const outputDirectory = (root: string) =>
    fs
      .makeTempDirectory({ directory: root, prefix: "studio-" })
      .pipe(Effect.mapError(() => failure("storage")));
  const remove = (directory: string) =>
    fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
  const run = (args: ReadonlyArray<string>, cwd: string, seconds: number) =>
    media
      .withJobSlot(
        runner.run({
          command: "ffmpeg",
          args,
          cwd,
          timeout: Duration.seconds(seconds),
          maxOutputBytes: 1024 * 1024,
        }),
      )
      .pipe(
        Effect.mapError(() => failure("render")),
        Effect.flatMap((result) =>
          result.code === 0 ? Effect.void : Effect.fail(failure("render")),
        ),
      );
  const audioPath = Effect.fn(
    function* (root: string, relativePath: string) {
      const target = yield* paths.resolveRelativePathWithinRoot({
        workspaceRoot: root,
        relativePath,
      });
      const real = yield* fs.realPath(target.absolutePath);
      const relative = path.relative(root, real);
      const stat = yield* fs.stat(real);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        stat.type !== "File" ||
        stat.size > 100_000_000n ||
        ![".mp3", ".wav", ".flac", ".ogg", ".m4a"].includes(path.extname(real).toLowerCase())
      )
        return yield* failure("invalid_input");
      return real;
    },
    Effect.mapError(() => failure("invalid_input")),
  );
  const render: StudioMedia["Service"]["render"] = Effect.fn("StudioMedia.render")(
    function* (input) {
      const shape = shapes[input.aspectRatio];
      const total = input.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
      if (
        !shape ||
        input.scenes.length < 1 ||
        input.scenes.length > 30 ||
        !Number.isFinite(total) ||
        total > 60 ||
        (input.fit !== undefined && input.fit !== "crop" && input.fit !== "pad")
      )
        return yield* failure("invalid_input");
      const captions: Caption[] = [];
      let offset = 0;
      for (const scene of input.scenes) {
        if (
          !Number.isFinite(scene.durationSeconds) ||
          scene.durationSeconds < 0.1 ||
          !Number.isFinite(scene.start ?? 0) ||
          (scene.start ?? 0) < 0
        )
          return yield* failure("invalid_input");
        const text = scene.onScreenText;
        const local = [
          ...(scene.captions ?? []),
          ...(text ? [{ start: 0, end: scene.durationSeconds, text }] : []),
        ];
        for (const caption of local) {
          if (
            !Number.isFinite(caption.start) ||
            !Number.isFinite(caption.end) ||
            caption.start < 0 ||
            caption.end <= caption.start ||
            caption.end > scene.durationSeconds ||
            !caption.text.trim() ||
            caption.text.length > 200
          )
            return yield* failure("invalid_input");
          captions.push({ ...caption, start: caption.start + offset, end: caption.end + offset });
        }
        offset += scene.durationSeconds;
      }
      if (captions.length > 200) return yield* failure("invalid_input");
      const scenes = yield* Effect.forEach(
        input.scenes,
        (scene) =>
          Effect.gen(function* () {
            const resolved = yield* media.resolveFile({ cwd: input.cwd, relativePath: scene.file });
            const probe = yield* media.probe({ cwd: input.cwd, relativePath: scene.file });
            const start = scene.start ?? 0;
            if (
              resolved.kind === "video" &&
              (probe.durationSeconds === null ||
                start + scene.durationSeconds > probe.durationSeconds + 0.05)
            )
              return yield* failure("invalid_input");
            if (resolved.kind === "image" && start !== 0) return yield* failure("invalid_input");
            return {
              filePath: resolved.realPath,
              image: resolved.kind === "image",
              start,
              durationSeconds: scene.durationSeconds,
              hasAudio: input.keepSourceAudio === true && probe.hasAudio,
            };
          }),
        { concurrency: 2 },
      );
      const root = yield* rootOf(input.cwd);
      const audio =
        input.audioFile === undefined ? undefined : yield* audioPath(root, input.audioFile);
      const directory = yield* outputDirectory(root);
      return yield* Effect.gen(function* () {
        const outputPath = path.join(directory, "render.mp4");
        if (captions.length)
          yield* fs
            .writeFileString(
              path.join(directory, "captions.ass"),
              buildAss({ ...PLATFORM_SHAPES[shape], captions }),
            )
            .pipe(Effect.mapError(() => failure("storage")));
        yield* run(
          buildStudioArgs({
            scenes,
            shape,
            fit: input.fit ?? "crop",
            captions: captions.length > 0,
            ...(audio === undefined ? {} : { audioPath: audio }),
            outputPath,
          }),
          directory,
          60 + total * 3,
        );
        const stat = yield* fs.stat(outputPath).pipe(Effect.mapError(() => failure("storage")));
        if (stat.size <= 0n || stat.size >= BigInt(MEDIA_EDIT_MAX_OUTPUT_BYTES))
          return yield* failure("render");
        const file = path.relative(root, outputPath);
        const probe = yield* media.probe({ cwd: root, relativePath: file });
        yield* fs.remove(path.join(directory, "captions.ass"), { force: true }).pipe(Effect.ignore);
        return { file, probe };
      }).pipe(Effect.onError(() => remove(directory)));
    },
  );
  const prepareNarration = Effect.fn(function* (input: NarrationInput) {
    const voiceId = input.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";
    if (!input.text.trim() || input.text.length > 5000 || !/^[A-Za-z0-9_-]{1,100}$/.test(voiceId))
      return yield* failure("invalid_input");
    const root = yield* rootOf(input.cwd);
    const key = yield* secrets
      .get("workbench-voice-elevenlabs")
      .pipe(Effect.mapError(() => failure("storage")));
    if (Option.isNone(key)) return yield* failure("not_configured");
    return { root, voiceId, key: key.value };
  });
  const checkNarration: StudioMedia["Service"]["checkNarration"] = (input) =>
    prepareNarration(input).pipe(Effect.asVoid);
  const narration: StudioMedia["Service"]["narration"] = Effect.fn("StudioMedia.narration")(
    function* (input) {
      // Recheck at execution because credentials or the workspace may change after approval.
      const { root, voiceId, key } = yield* prepareNarration(input);
      const directory = yield* outputDirectory(root);
      // Official saved-audio endpoint: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
      // Do not retry: a timeout can mean audio was generated and billed already.
      return yield* Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        ).pipe(
          HttpClientRequest.setUrlParam("output_format", "mp3_44100_128"),
          HttpClientRequest.setHeader("xi-api-key", new TextDecoder().decode(key)),
          HttpClientRequest.setHeader("accept", "audio/mpeg"),
          HttpClientRequest.bodyJson({ text: input.text, model_id: "eleven_multilingual_v2" }),
        );
        const response = yield* client.execute(request);
        if (response.status !== 200 || !response.headers["content-type"]?.startsWith("audio/"))
          return yield* failure("provider");
        let size = 0;
        const target = path.join(directory, "narration.mp3");
        yield* response.stream.pipe(
          Stream.mapEffect((chunk) => {
            size += chunk.byteLength;
            return size > 10_000_000 ? Effect.fail(failure("provider")) : Effect.succeed(chunk);
          }),
          Stream.run(fs.sink(target)),
        );
        if (size === 0) return yield* failure("provider");
        // Decode locally before exposing a saved asset to the rest of Studio.
        yield* run(
          [
            "-nostdin",
            "-v",
            "error",
            ...STUDIO_AUDIO_INPUT_ARGS,
            "-i",
            target,
            "-map",
            "0:a:0",
            "-t",
            "61",
            "-f",
            "null",
            "-",
          ],
          directory,
          15,
        );
        return {
          file: path.relative(root, target),
          providerRequestId: response.headers["request-id"] ?? null,
        };
      }).pipe(
        Effect.timeout("90 seconds"),
        Effect.mapError(() => failure("provider")),
        Effect.onError(() => remove(directory)),
      );
    },
  );
  return StudioMedia.of({
    render,
    checkNarration,
    narration: (input) => narrationJobs.withPermits(1)(narration(input)),
  });
});
export const layer = Layer.effect(StudioMedia, make);
