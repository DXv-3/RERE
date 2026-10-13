import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import { describe, expect, it as plainIt } from "vite-plus/test";

import { LOCAL_GPU_PRESETS, LOCAL_GPU_VIDEO_PRESETS } from "@t3tools/shared/campaignRules";

import * as ProcessRunner from "../../processRunner.ts";
import { locateLocalGpuScript } from "./localGpuScript.ts";
import type { GenerationConnector, GenerationRequest } from "./GenerationConnector.ts";
import {
  BUSY,
  localGpuSize,
  localGpuVideoShape,
  makeLocalGpuConnector,
  NEEDS_FIRST_FRAME,
  SCRIPT_MISSING,
  VIDEO_SCRIPT_MISSING,
  VIDEO_TIMEOUT,
  videoSecondsOf,
  type LocalGpuConfig,
} from "./LocalGpuConnector.ts";

const SCRIPT = "/app/localgen/generate_image.py";
const VIDEO_SCRIPT = "/app/localgen/generate_video.py";
const PYTHON = process.execPath;

const VIDEO_MODEL = "wan22-ti2v-5b";
const STILL = "/home/me/project/campaigns/a/b/generated/job1.png";

const output = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const request = (overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  kind: "image",
  model: "lcm-dreamshaper-v7",
  prompt: "A bouquet on a white table",
  options: { aspectRatio: "16:9" },
  name: "A bouquet",
  workDir: "/tmp/work",
  ...overrides,
});

type Handler = (
  input: ProcessRunner.ProcessRunInput,
) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

/** A connector wired to a fake runner that records every program it was asked to start. */
const setup = (
  handler: Handler,
  options: {
    readonly config?: Partial<LocalGpuConfig>;
    readonly script?: string | null;
    readonly videoScript?: string | null;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const seen: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) => {
        seen.push(input);
        return handler(input);
      },
    });
    const connector = makeLocalGpuConnector({
      runner,
      fileSystem,
      path,
      homeDir: "/home/someone",
      config: Effect.succeed({
        python: PYTHON,
        model: "",
        modelsDir: "",
        whenBusy: "fallback" as const,
        ...options.config,
      }),
      script: Effect.succeed(options.script === undefined ? SCRIPT : options.script),
      videoScript: Effect.succeed(
        options.videoScript === undefined ? VIDEO_SCRIPT : options.videoScript,
      ),
    });
    return { connector, seen };
  });

const downloadOf = (connector: GenerationConnector) =>
  connector.download ?? (() => Effect.die("this connector has no download step"));

const spawnError = (command: string) =>
  new ProcessRunner.ProcessSpawnError({ command, argumentCount: 0, cause: new Error("nope") });

describe("localGpuSize", () => {
  plainIt("puts the model's best size on the longer side", () => {
    expect(localGpuSize("16:9", "lcm-dreamshaper-v7")).toEqual({ width: 768, height: 432 });
    expect(localGpuSize("9:16", "lcm-dreamshaper-v7")).toEqual({ width: 432, height: 768 });
    expect(localGpuSize("1:1", "sdxl-base-1.0")).toEqual({ width: 1024, height: 1024 });
    expect(localGpuSize(undefined, "/some/folder")).toEqual({ width: 768, height: 768 });
  });
});

it.effect(
  "start runs the script directly with one argument per option, never through a shell",
  () =>
    Effect.gen(function* () {
      const hostile = `--steps=1; rm -rf / && echo "$(whoami)" | sh \`id\``;
      const { connector, seen } = yield* setup(() =>
        Effect.succeed(output('{"ok":true,"path":"/tmp/work/image.png","seconds":4.1}\n')),
      );
      const result = yield* connector.start(request({ prompt: hostile }));
      assert.deepStrictEqual(result, {
        kind: "finished",
        urls: [],
        files: ["/tmp/work/image.png"],
      });
      assert.strictEqual(seen.length, 1);
      const run = seen[0];
      assert.strictEqual(run?.command, PYTHON);
      assert.deepStrictEqual(run?.args, [
        "-I",
        SCRIPT,
        `--prompt=${hostile}`,
        "--width=768",
        "--height=432",
        "--model=lcm-dreamshaper-v7",
        "--models-dir=/home/someone/.codewrench/localgen/models",
        "--out=/tmp/work/image.png",
      ]);
      // The prompt is exactly one argument, glued to its flag so it can never be read as an option.
      assert.strictEqual(run?.args.filter((arg) => arg.includes(hostile)).length, 1);
      assert.strictEqual(run?.timeout !== undefined, true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("start uses the configured model and models folder", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() => Effect.succeed(output('{"ok":true}\n')), {
      config: { model: "/models/mine", modelsDir: "~/weights" },
    });
    yield* connector.start(request({ model: "/models/mine" }));
    assert.include(seen[0]?.args ?? [], "--model=/models/mine");
    assert.include(seen[0]?.args ?? [], "--models-dir=/home/someone/weights");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("wait mode passes --no-fallback and turns a busy refusal into a waiting result", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(
      () =>
        Effect.succeed(
          output(
            '{"ok":false,"busy":true,"freeGb":3.3,"needGb":6.5,"reason":"The GPU has 3.3 GB free."}\n',
            1,
          ),
        ),
      { config: { whenBusy: "wait" } },
    );
    const result = yield* connector.start(request());
    assert.deepStrictEqual(result, {
      kind: "waiting",
      note: "Waiting for the graphics card: 3.3 GB free, this model needs 6.5 GB.",
    });
    assert.include(seen[0]?.args ?? [], "--no-fallback");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fallback mode never passes --no-fallback", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() => Effect.succeed(output('{"ok":true}\n')));
    yield* connector.start(request());
    assert.notInclude(seen[0]?.args ?? [], "--no-fallback");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("each failure comes back as a plain sentence", () =>
  Effect.gen(function* () {
    const failWith = (handler: Handler, options?: Parameters<typeof setup>[1]) =>
      Effect.gen(function* () {
        const { connector } = yield* setup(handler, options);
        return yield* Effect.flip(connector.start(request()));
      });

    assert.strictEqual(
      yield* failWith(() => Effect.succeed(output("")), { script: null }),
      SCRIPT_MISSING,
    );
    assert.include(
      yield* failWith(() => Effect.succeed(output("")), {
        config: { python: "/no/such/python" },
      }),
      "There is no Python program at /no/such/python",
    );
    assert.include(
      yield* failWith(() => Effect.fail(spawnError(PYTHON))),
      "Python could not be started",
    );
    assert.include(
      yield* failWith(() =>
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: PYTHON,
            argumentCount: 0,
            timeoutMs: 600_000,
          }),
        ),
      ),
      "longer than 10 minutes",
    );
    assert.include(
      yield* failWith(() => Effect.succeed(output("Traceback...\n", 1, "boom: it broke\n"))),
      "could not be read (it stopped with code 1). It said: boom: it broke",
    );
    assert.strictEqual(
      yield* failWith(() =>
        Effect.succeed(
          output(
            '{"ok":false,"reason":"The GPU has 3.3 GB free and this model needs about 8 GB. Text models are using the rest."}\n',
            1,
          ),
        ),
      ),
      "The GPU has 3.3 GB free and this model needs about 8 GB. Text models are using the rest.",
    );
    assert.strictEqual(
      yield* failWith(() =>
        Effect.succeed(
          output(
            '{"ok":false,"reason":"This model has not been downloaded yet. Download it in Settings first."}\n',
            1,
          ),
        ),
      ),
      "This model has not been downloaded yet. Download it in Settings first.",
    );
    // A video with no still never starts the program.
    const video = yield* setup(() => Effect.succeed(output("")));
    assert.strictEqual(
      yield* Effect.flip(video.connector.start(request({ kind: "video", model: VIDEO_MODEL }))),
      NEEDS_FIRST_FRAME,
    );
    assert.strictEqual(video.seen.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("with no Python configured it uses the first one that has PyTorch and diffusers", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(
      (input) =>
        Effect.succeed(
          input.args.includes("-c")
            ? output("", input.command === "python3" ? 0 : 1)
            : output('{"ok":true}\n'),
        ),
      { config: { python: "" } },
    );
    yield* connector.start(request());
    const probes = seen.filter((run) => run.args.includes("-c")).map((run) => run.command);
    assert.deepStrictEqual(probes.slice(-1), ["python3"]);
    assert.strictEqual(seen.at(-1)?.command, "python3");

    const none = yield* setup(() => Effect.succeed(output("", 1)), { config: { python: "" } });
    assert.include(
      yield* Effect.flip(none.connector.start(request())),
      "No Python with PyTorch and diffusers was found",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("only one image is made at a time, and a check says the card is busy meanwhile", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    let running = 0;
    let most = 0;
    const { connector, seen } = yield* setup((input) => {
      if (input.args.includes("--check")) return Effect.succeed(output('{"ok":true,"lines":[]}\n'));
      return Effect.gen(function* () {
        running += 1;
        most = Math.max(most, running);
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(gate);
        running -= 1;
        return output('{"ok":true}\n');
      });
    });
    const first = yield* Effect.forkChild(connector.start(request()));
    const second = yield* Effect.forkChild(connector.start(request()));
    yield* Deferred.await(entered);
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(yield* connector.test(), { ok: false, reason: BUSY });
    assert.deepStrictEqual(yield* downloadOf(connector)(), { ok: false, reason: BUSY });
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.strictEqual(most, 1);
    assert.strictEqual(seen.filter((run) => !run.args.includes("--check")).length, 2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("test reports each line of the self-check in plain words", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() =>
      Effect.succeed(
        output(
          JSON.stringify({
            ok: false,
            reason:
              "This model has not been downloaded yet. Download it in Settings first. It is about 4.3 GB.",
            lines: [
              { ok: true, text: "PyTorch 2.11.0 and diffusers 0.41.0 are installed." },
              {
                ok: false,
                text: "This model has not been downloaded yet. Download it in Settings first. It is about 4.3 GB.",
              },
            ],
          }) + "\n",
          1,
        ),
      ),
    );
    const result = yield* connector.test();
    assert.deepStrictEqual(result, {
      ok: false,
      reason:
        "This model has not been downloaded yet. Download it in Settings first. It is about 4.3 GB.",
      notes:
        "OK: PyTorch 2.11.0 and diffusers 0.41.0 are installed.\nProblem: This model has not been downloaded yet. Download it in Settings first. It is about 4.3 GB.",
    });
    assert.include(seen[0]?.args ?? [], "--check");
    // The default model is the small preset.
    assert.include(seen[0]?.args ?? [], "--model=lcm-dreamshaper-v7");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("download runs the script's download step and reports its size and progress lines", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() =>
      Effect.succeed(
        output(
          '{"ok":true,"bytes":4266993365,"seconds":115.9}\n',
          0,
          "Downloading SimianLuo/LCM_Dreamshaper_v7 (MIT): 12 files, 3.97 GB.\nnoise\nFile 12 of 12: vae/x.safetensors (335 MB). 3.97 of 3.97 GB.\n",
        ),
      ),
    );
    const result = yield* downloadOf(connector)();
    assert.deepStrictEqual(result, {
      ok: true,
      notes:
        "Downloaded 4.3 GB in 116 seconds.\nDownloading SimianLuo/LCM_Dreamshaper_v7 (MIT): 12 files, 3.97 GB.\nFile 12 of 12: vae/x.safetensors (335 MB). 3.97 of 3.97 GB.",
    });
    assert.include(seen[0]?.args ?? [], "--download");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the cost estimate is zero and says it runs on this computer", () =>
  Effect.gen(function* () {
    const { connector } = yield* setup(() => Effect.succeed(output("")));
    assert.deepStrictEqual(connector.estimate(request()), {
      usd: 0,
      note: "Runs on this computer.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the shipped script is found from source and agrees with the presets in settings", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const found = yield* locateLocalGpuScript(fileSystem, path);
    assert.isString(found);
    const text = yield* fileSystem.readFileString(found ?? "");
    for (const preset of LOCAL_GPU_PRESETS) {
      assert.include(text, `id="${preset.id}"`);
      assert.include(text, `need_gib=${preset.freeGb.toFixed(1)}`);
      assert.include(text, `download_gb=${preset.downloadGb.toFixed(1)}`);
      assert.include(text, `long_edge=${preset.longEdge}`);
    }
    const video = yield* locateLocalGpuScript(fileSystem, path, undefined, "generate_video.py");
    assert.isString(video);
    const videoText = yield* fileSystem.readFileString(video ?? "");
    for (const preset of LOCAL_GPU_VIDEO_PRESETS) {
      assert.include(videoText, `id="${preset.id}"`);
      assert.include(videoText, `need_gib=${preset.freeGb.toFixed(1)}`);
      assert.include(videoText, `download_gb=${preset.downloadGb.toFixed(1)}`);
      assert.include(videoText, `steps=30`);
      assert.include(videoText, `min_seconds=${preset.minSeconds}`);
      assert.include(videoText, `max_seconds=${preset.maxSeconds}`);
      assert.strictEqual(preset.pixelBudget, 640 * 640);
      assert.include(videoText, "pixel_budget=640 * 640");
    }
    assert.strictEqual(yield* locateLocalGpuScript(fileSystem, path, "/nowhere/at/all"), null);
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("video helpers", () => {
  plainIt("hands the script the aspect ratio's own numbers, or zeros to follow the still", () => {
    expect(localGpuVideoShape("9:16")).toEqual({ width: 9, height: 16 });
    expect(localGpuVideoShape("16:9")).toEqual({ width: 16, height: 9 });
    expect(localGpuVideoShape(undefined)).toEqual({ width: 0, height: 0 });
    expect(localGpuVideoShape("nonsense")).toEqual({ width: 0, height: 0 });
  });

  plainIt("holds the length to what the model makes", () => {
    expect(videoSecondsOf(VIDEO_MODEL, undefined)).toBe(5);
    expect(videoSecondsOf(VIDEO_MODEL, 4)).toBe(4);
    expect(videoSecondsOf(VIDEO_MODEL, 1)).toBe(3);
    expect(videoSecondsOf(VIDEO_MODEL, 30)).toBe(5);
  });

  plainIt("allows a longer limit for video than for images", () => {
    expect(VIDEO_TIMEOUT).toEqual(Duration.minutes(30));
  });
});

const videoRequest = (overrides: Partial<GenerationRequest> = {}): GenerationRequest =>
  request({
    kind: "video",
    model: VIDEO_MODEL,
    options: { aspectRatio: "9:16", durationSeconds: 4 },
    firstFramePath: STILL,
    ...overrides,
  });

it.effect("a video runs the video script with the still, one argument per option", () =>
  Effect.gen(function* () {
    const hostile = `--out=/etc/passwd; $(reboot)`;
    const { connector, seen } = yield* setup(() =>
      Effect.succeed(output('{"ok":true,"path":"/tmp/work/video.mp4","seconds":300}\n')),
    );
    const result = yield* connector.start(videoRequest({ prompt: hostile }));
    assert.deepStrictEqual(result, { kind: "finished", urls: [], files: ["/tmp/work/video.mp4"] });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]?.command, PYTHON);
    assert.deepStrictEqual(seen[0]?.args, [
      "-I",
      VIDEO_SCRIPT,
      `--prompt=${hostile}`,
      `--image=${STILL}`,
      "--width=9",
      "--height=16",
      "--seconds=4",
      `--model=${VIDEO_MODEL}`,
      "--models-dir=/home/someone/.codewrench/localgen/models",
      "--out=/tmp/work/video.mp4",
      "--no-fallback",
    ]);
    // Thirty minutes, not the image limit.
    assert.deepStrictEqual(seen[0]?.timeout, VIDEO_TIMEOUT);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a video without a still fails in plain words and never starts the program", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() => Effect.succeed(output("")));
    for (const firstFramePath of [undefined, ""]) {
      assert.strictEqual(
        yield* Effect.flip(connector.start(videoRequest({ firstFramePath }))),
        "This computer makes video from a still image. Choose an image to start from.",
      );
    }
    assert.strictEqual(seen.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a busy card always means waiting for a video, even when images fall back", () =>
  Effect.gen(function* () {
    const { connector } = yield* setup(
      () =>
        Effect.succeed(
          output('{"ok":false,"busy":true,"freeGb":4.1,"needGb":7.5,"reason":"busy"}\n', 1),
        ),
      { config: { whenBusy: "fallback" } },
    );
    assert.deepStrictEqual(yield* connector.start(videoRequest()), {
      kind: "waiting",
      note: "Waiting for the graphics card: 4.1 GB free, this model needs 7.5 GB.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("each video failure comes back as a plain sentence", () =>
  Effect.gen(function* () {
    const failWith = (handler: Handler, options?: Parameters<typeof setup>[1]) =>
      Effect.gen(function* () {
        const { connector } = yield* setup(handler, options);
        return yield* Effect.flip(connector.start(videoRequest()));
      });
    assert.strictEqual(
      yield* failWith(() => Effect.succeed(output("")), { videoScript: null }),
      VIDEO_SCRIPT_MISSING,
    );
    assert.include(
      yield* failWith(() => Effect.fail(spawnError(PYTHON))),
      "Python could not be started",
    );
    assert.include(
      yield* failWith(() =>
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: PYTHON,
            argumentCount: 0,
            timeoutMs: 1_800_000,
          }),
        ),
      ),
      "longer than 30 minutes",
    );
    assert.include(
      yield* failWith(() => Effect.succeed(output("Traceback...\n", 1, "boom\n"))),
      "The video program gave an answer that could not be read (it stopped with code 1). It said: boom",
    );
    assert.strictEqual(
      yield* failWith(() =>
        Effect.succeed(output('{"ok":false,"reason":"ffmpeg is not installed."}\n', 1)),
      ),
      "ffmpeg is not installed.",
    );
    assert.strictEqual(
      yield* failWith(() => Effect.succeed(output('{"ok":false}\n', 1))),
      "The video could not be made.",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a video needs a folder to be made in", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() => Effect.succeed(output("")));
    assert.strictEqual(
      yield* Effect.flip(connector.start(videoRequest({ workDir: undefined }))),
      "There was no folder to make the video in.",
    );
    assert.strictEqual(seen.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a video and an image never run at the same time", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let running = 0;
    let most = 0;
    const { connector } = yield* setup((input) =>
      Effect.gen(function* () {
        if (input.args.includes("-c")) return output("");
        running += 1;
        most = Math.max(most, running);
        yield* Deferred.await(gate);
        running -= 1;
        return output('{"ok":true}\n');
      }),
    );
    const video = yield* Effect.forkChild(connector.start(videoRequest()));
    const image = yield* Effect.forkChild(connector.start(request()));
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    // A check does not queue behind them either: it says the card is busy.
    assert.deepStrictEqual(yield* connector.test("video"), { ok: false, reason: BUSY });
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(video);
    yield* Fiber.join(image);
    assert.strictEqual(most, 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("test and download for video use the video script and the chosen video model", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(
      () => Effect.succeed(output('{"ok":true,"bytes":34200000000,"seconds":900}\n')),
      { config: { videoModel: "wan22-ti2v-5b", model: "sdxl-base-1.0" } },
    );
    yield* connector.test("video");
    assert.deepStrictEqual(seen[0]?.args, [
      "-I",
      VIDEO_SCRIPT,
      "--check",
      `--model=${VIDEO_MODEL}`,
      "--models-dir=/home/someone/.codewrench/localgen/models",
    ]);
    const done = yield* downloadOf(connector)("video");
    assert.deepStrictEqual(seen[1]?.args.slice(0, 4), [
      "-I",
      VIDEO_SCRIPT,
      "--download",
      `--model=${VIDEO_MODEL}`,
    ]);
    assert.strictEqual(done.ok, true);
    // With no kind it is still the image model and the image script.
    yield* connector.test();
    assert.deepStrictEqual(seen[2]?.args.slice(0, 4), [
      "-I",
      SCRIPT,
      "--check",
      "--model=sdxl-base-1.0",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("with no video model set the default one is used", () =>
  Effect.gen(function* () {
    const { connector, seen } = yield* setup(() => Effect.succeed(output('{"ok":true}\n')));
    yield* connector.test("video");
    assert.include(seen[0]?.args ?? [], `--model=${VIDEO_MODEL}`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a video costs nothing and says it runs on this computer", () =>
  Effect.gen(function* () {
    const { connector } = yield* setup(() => Effect.succeed(output("")));
    assert.deepStrictEqual(connector.estimate(videoRequest()), {
      usd: 0,
      note: "Runs on this computer.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
