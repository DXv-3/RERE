import {
  estimateGenerationUsd,
  localGpuBusyNote,
  LOCAL_GPU_DEFAULT_VIDEO_PRESET,
  LOCAL_GPU_PRESETS,
  LOCAL_GPU_VIDEO_PRESETS,
} from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type * as ProcessRunner from "../../processRunner.ts";
import type {
  GenerationConnector,
  GenerationRequest,
  GenerationTestResult,
} from "./GenerationConnector.ts";

/** What the settings hold. Empty strings mean "use the default". */
export interface LocalGpuConfig {
  readonly python: string;
  readonly model: string;
  /** The video preset. Empty means the default one. */
  readonly videoModel?: string;
  readonly modelsDir: string;
  /** "wait" refuses to use a smaller model; the job waits for room instead. */
  readonly whenBusy: "fallback" | "wait";
}

export const LOCAL_GPU_DEFAULT_MODEL = LOCAL_GPU_PRESETS[0].id;
export const LOCAL_GPU_DEFAULT_VIDEO_MODEL = LOCAL_GPU_DEFAULT_VIDEO_PRESET;
const DEFAULT_MODELS_DIR = ".codewrench/localgen/models";
export const SCRIPT_MISSING =
  "The image program that comes with CodeWrench is missing from this install. Reinstall CodeWrench.";
export const VIDEO_SCRIPT_MISSING =
  "The video program that comes with CodeWrench is missing from this install. Reinstall CodeWrench.";
export const BUSY =
  "An image or video is being made on this graphics card right now. Try again when it is done.";
export const NEEDS_FIRST_FRAME =
  "This computer makes video from a still image. Choose an image to start from.";
const IMAGE_TIMEOUT = Duration.minutes(10);
export const VIDEO_TIMEOUT = Duration.minutes(30);
const CHECK_TIMEOUT = Duration.minutes(2);
const DOWNLOAD_TIMEOUT = Duration.hours(1);
const PROBE_TIMEOUT = Duration.seconds(60);
const OUTPUT_CAP_BYTES = 1024 * 1024;
const REASON_MAX_CHARS = 400;

const ScriptReply = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  /** True when the script refused only because too little graphics memory was free. */
  busy: Schema.optional(Schema.Boolean),
  freeGb: Schema.optional(Schema.Number),
  needGb: Schema.optional(Schema.Number),
  seconds: Schema.optional(Schema.Number),
  bytes: Schema.optional(Schema.Number),
  lines: Schema.optional(Schema.Array(Schema.Struct({ ok: Schema.Boolean, text: Schema.String }))),
});
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ScriptReply));

/** Width and height for an aspect ratio: the longer side is the model's own best size. */
export const localGpuSize = (
  aspectRatio: string | undefined,
  model: string,
): { readonly width: number; readonly height: number } => {
  const longEdge = LOCAL_GPU_PRESETS.find((preset) => preset.id === model)?.longEdge ?? 768;
  const [w, h] = (aspectRatio ?? "1:1").split(":").map(Number);
  if (!w || !h) return { width: longEdge, height: longEdge };
  const short = Math.max(64, Math.round((longEdge * Math.min(w, h)) / Math.max(w, h) / 8) * 8);
  return w >= h ? { width: longEdge, height: short } : { width: short, height: longEdge };
};

/**
 * The shape the video script is asked for: the aspect ratio's own numbers, e.g. 9:16 gives 9 and
 * 16. With none given, 0 and 0 tell it to follow the shape of the still.
 */
export const localGpuVideoShape = (
  aspectRatio: string | undefined,
): { readonly width: number; readonly height: number } => {
  const [w, h] = (aspectRatio ?? "").split(":").map(Number);
  return w && h ? { width: w, height: h } : { width: 0, height: 0 };
};

/** The clip length asked for, held to what the preset makes (the service has checked it already). */
export const videoSecondsOf = (model: string, requested: number | undefined): number => {
  const preset = LOCAL_GPU_VIDEO_PRESETS.find((candidate) => candidate.id === model);
  const wanted = requested ?? preset?.maxSeconds ?? 5;
  return preset === undefined
    ? wanted
    : Math.min(preset.maxSeconds, Math.max(preset.minSeconds, wanted));
};

const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line !== "");

/**
 * Makes images by running the bundled Python script on this computer's graphics card. The script
 * is started directly with an argument list (the prompt is untrusted text and never meets a
 * shell). One run at a time: two would fight over the card's memory. The script itself refuses
 * when too little memory is free, so text models are never pushed out.
 */
export function makeLocalGpuConnector(deps: {
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly config: Effect.Effect<LocalGpuConfig>;
  /** The script's path, or null when it was not shipped with this install. */
  readonly script: Effect.Effect<string | null>;
  /** The video script's path, or null when it was not shipped with this install. */
  readonly videoScript?: Effect.Effect<string | null>;
}): GenerationConnector {
  const { runner, fileSystem, path } = deps;
  const lock = Semaphore.makeUnsafe(1);

  const modelOf = (config: LocalGpuConfig) => config.model.trim() || LOCAL_GPU_DEFAULT_MODEL;
  const videoModelOf = (config: LocalGpuConfig) =>
    config.videoModel?.trim() || LOCAL_GPU_DEFAULT_VIDEO_MODEL;
  const modelsDirOf = (config: LocalGpuConfig) => {
    const raw = config.modelsDir.trim();
    if (raw === "") return path.join(deps.homeDir, DEFAULT_MODELS_DIR);
    return raw.startsWith("~/") ? path.join(deps.homeDir, raw.slice(2)) : raw;
  };

  const run = (
    python: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Duration,
    timeoutText: string,
  ) =>
    runner
      .run({
        command: python,
        args,
        timeout,
        maxOutputBytes: OUTPUT_CAP_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "ProcessSpawnError":
              return `Python could not be started (${python}). Check the Python path in Settings.`;
            case "ProcessTimeoutError":
              return timeoutText;
            default:
              return "The image program stopped in an unexpected way.";
          }
        }),
      );

  /** The configured Python, or the first one that has PyTorch and diffusers. */
  const resolvePython = (config: LocalGpuConfig) =>
    Effect.gen(function* () {
      const chosen = config.python.trim();
      if (chosen !== "") {
        if (!(yield* fileSystem.exists(chosen).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.fail(
            `There is no Python program at ${chosen}. Check the Python path in Settings.`,
          );
        }
        return { python: chosen, found: false } as const;
      }
      const candidates = [
        path.join(deps.homeDir, ".codewrench/localgen/venv/bin/python"),
        path.join(deps.homeDir, ".codewrench/localgen/venv/Scripts/python.exe"),
        "python3",
        "python",
      ];
      for (const candidate of candidates) {
        const probe = yield* runner
          .run({
            command: candidate,
            args: ["-I", "-c", "import torch, diffusers"],
            timeout: PROBE_TIMEOUT,
            maxOutputBytes: OUTPUT_CAP_BYTES,
            outputMode: "truncate",
          })
          .pipe(Effect.orElseSucceed(() => null));
        if (probe?.code === 0) return { python: candidate, found: true } as const;
      }
      return yield* Effect.fail(
        "No Python with PyTorch and diffusers was found. Install them, then set the Python path in Settings.",
      );
    });

  const scriptPath = deps.script.pipe(
    Effect.filterOrFail(
      (found): found is string => found !== null,
      () => SCRIPT_MISSING,
    ),
  );
  const videoScriptPath = (deps.videoScript ?? Effect.succeed(null)).pipe(
    Effect.filterOrFail(
      (found): found is string => found !== null,
      () => VIDEO_SCRIPT_MISSING,
    ),
  );

  /** Runs the script and reads the one JSON line it ends with. */
  const runScript = (
    python: string,
    script: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Duration,
    timeoutText: string,
    noun: "image" | "video" = "image",
  ) =>
    Effect.gen(function* () {
      const output = yield* run(python, ["-I", script, ...args], timeout, timeoutText);
      const reply = decodeReply(lastLine(output.stdout) ?? "");
      if (reply._tag === "None") {
        const detail = lastLine(output.stderr)?.slice(0, REASON_MAX_CHARS);
        return yield* Effect.fail(
          `The ${noun} program gave an answer that could not be read${output.code === 0 ? "" : ` (it stopped with code ${output.code})`}.${detail === undefined ? "" : ` It said: ${detail}`}`,
        );
      }
      return { reply: reply.value, stderr: output.stderr };
    });

  /**
   * A video from a still. There is no smaller video model, so a card with too little room is
   * always "waiting", whatever the busy setting says: the job tries again later.
   */
  const startVideo = (request: GenerationRequest, workDir: string) =>
    Effect.gen(function* () {
      if (request.firstFramePath === undefined || request.firstFramePath === "") {
        return yield* Effect.fail(NEEDS_FIRST_FRAME);
      }
      const config = yield* deps.config;
      const script = yield* videoScriptPath;
      const { python } = yield* resolvePython(config);
      const out = path.join(workDir, "video.mp4");
      const { width, height } = localGpuVideoShape(request.options.aspectRatio);
      const { reply } = yield* runScript(
        python,
        script,
        [
          `--prompt=${request.prompt}`,
          `--image=${request.firstFramePath}`,
          `--width=${width}`,
          `--height=${height}`,
          `--seconds=${videoSecondsOf(request.model, request.options.durationSeconds)}`,
          `--model=${request.model}`,
          `--models-dir=${modelsDirOf(config)}`,
          `--out=${out}`,
          "--no-fallback",
        ],
        VIDEO_TIMEOUT,
        "The video took longer than 30 minutes, so it was stopped. Nothing was charged.",
        "video",
      );
      if (!reply.ok && reply.busy === true) {
        return {
          kind: "waiting",
          note: localGpuBusyNote(reply.freeGb ?? 0, reply.needGb ?? 0),
        } as const;
      }
      if (!reply.ok) return yield* Effect.fail(reply.reason ?? "The video could not be made.");
      return { kind: "finished", urls: [], files: [out] } as const;
    });

  const start: GenerationConnector["start"] = (request: GenerationRequest) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (request.workDir === undefined) {
          return yield* Effect.fail(
            `There was no folder to make the ${request.kind === "video" ? "video" : "image"} in.`,
          );
        }
        if (request.kind === "video") return yield* startVideo(request, request.workDir);
        const config = yield* deps.config;
        const script = yield* scriptPath;
        const { python } = yield* resolvePython(config);
        const out = path.join(request.workDir, "image.png");
        const { width, height } = localGpuSize(request.options.aspectRatio, request.model);
        const { reply } = yield* runScript(
          python,
          script,
          [
            `--prompt=${request.prompt}`,
            `--width=${width}`,
            `--height=${height}`,
            `--model=${request.model}`,
            `--models-dir=${modelsDirOf(config)}`,
            `--out=${out}`,
            ...(config.whenBusy === "wait" ? ["--no-fallback"] : []),
          ],
          IMAGE_TIMEOUT,
          "The image took longer than 10 minutes, so it was stopped. Nothing was charged.",
        );
        if (!reply.ok && reply.busy === true && config.whenBusy === "wait") {
          return {
            kind: "waiting",
            note: localGpuBusyNote(reply.freeGb ?? 0, reply.needGb ?? 0),
          } as const;
        }
        if (!reply.ok) {
          return yield* Effect.fail(reply.reason ?? "The image could not be made.");
        }
        return { kind: "finished", urls: [], files: [out] } as const;
      }),
    );

  /** A check or a download never waits behind a running image: it says the card is busy. */
  const exclusive = (
    effect: Effect.Effect<GenerationTestResult, string>,
  ): Effect.Effect<GenerationTestResult> =>
    lock
      .withPermitsIfAvailable(1)(effect)
      .pipe(
        Effect.map((result) =>
          result._tag === "Some" ? result.value : ({ ok: false, reason: BUSY } as const),
        ),
        Effect.catch((reason: string) => Effect.succeed({ ok: false, reason } as const)),
      );

  const test: GenerationConnector["test"] = (kind) =>
    exclusive(
      Effect.gen(function* () {
        const config = yield* deps.config;
        const video = kind === "video";
        const script = yield* video ? videoScriptPath : scriptPath;
        const { python, found } = yield* resolvePython(config);
        const { reply } = yield* runScript(
          python,
          script,
          [
            "--check",
            `--model=${video ? videoModelOf(config) : modelOf(config)}`,
            `--models-dir=${modelsDirOf(config)}`,
          ],
          CHECK_TIMEOUT,
          "The check took longer than 2 minutes, so it was stopped.",
          video ? "video" : "image",
        );
        const lines = (reply.lines ?? []).map(
          (line) => `${line.ok ? "OK" : "Problem"}: ${line.text}`,
        );
        const notes = [found ? `OK: Using the Python found at ${python}.` : null, ...lines]
          .filter((line) => line !== null)
          .join("\n");
        return reply.ok
          ? ({ ok: true, notes } as const)
          : ({ ok: false, reason: reply.reason ?? "The check found a problem.", notes } as const);
      }),
    );

  const download: NonNullable<GenerationConnector["download"]> = (kind) =>
    exclusive(
      Effect.gen(function* () {
        const config = yield* deps.config;
        const video = kind === "video";
        const model = video ? videoModelOf(config) : modelOf(config);
        const script = yield* video ? videoScriptPath : scriptPath;
        const { python } = yield* resolvePython(config);
        const { reply, stderr } = yield* runScript(
          python,
          script,
          ["--download", `--model=${model}`, `--models-dir=${modelsDirOf(config)}`],
          DOWNLOAD_TIMEOUT,
          "The download took longer than an hour, so it was stopped. Start it again to continue where it left off.",
          video ? "video" : "image",
        );
        const progress = stderr
          .split(/\r?\n/)
          .filter((line) => /^(Downloading|File \d+ of)/.test(line))
          .join("\n");
        if (!reply.ok) {
          return {
            ok: false,
            reason: reply.reason ?? "The download did not finish.",
            notes: progress,
          } as const;
        }
        const size = ((reply.bytes ?? 0) / 1e9).toFixed(1);
        const seconds = Math.round(reply.seconds ?? 0);
        return {
          ok: true,
          notes: `Downloaded ${size} GB in ${seconds} seconds.\n${progress}`,
        } as const;
      }),
    );

  return {
    kind: "local-gpu",
    estimate: (request) =>
      estimateGenerationUsd({ connector: "local-gpu", kind: request.kind, model: request.model }),
    start,
    // The image is made before `start` returns, so there is never anything to poll.
    poll: () =>
      Effect.succeed({ state: "failed", reason: "The graphics card has no jobs to poll." }),
    test,
    download,
  };
}
