import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { LOCAL_GPU_WAIT_LIMIT_MS } from "@t3tools/shared/campaignRules";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as GenerationService from "./GenerationService.ts";
import * as GenerationStore from "./GenerationStore.ts";
import { makeHarnessLayer, makeWorld, type GenerationWorld } from "./generationTestHarness.ts";

const result = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const flagValue = (args: ReadonlyArray<string>, flag: string) =>
  args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

/** A script that writes a small file where it was told to, like the real one does. */
const writesImage =
  (fileSystem: FileSystem.FileSystem): GenerationWorld["program"]["current"] =>
  (input) =>
    Effect.gen(function* () {
      const out = flagValue(input.args, "--out");
      if (out !== undefined) yield* Effect.orDie(fileSystem.writeFileString(out, "PNGBYTES"));
      return result(`{"ok":true,"path":"${out}","seconds":4.1}\n`);
    });

interface Scene {
  readonly world: GenerationWorld;
  readonly root: string;
  readonly service: GenerationService.GenerationService["Service"];
  readonly jobs: GenerationStore.GenerationStore["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly clientId: string;
}

const scenario = <E>(
  body: (scene: Scene) => Effect.Effect<void, E, CampaignStore.CampaignStore>,
  generator: "local-gpu" | "none" = "local-gpu",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const world = yield* makeWorld;
    world.program.current = writesImage(fileSystem);
    yield* Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      const client = yield* store.upsertClient({
        name: "Candid Studios",
        brandNotes: "",
        doNotSay: [],
        approvalMode: "report-when-done",
      });
      yield* body({
        world,
        root,
        service: yield* GenerationService.GenerationService,
        jobs: yield* GenerationStore.GenerationStore,
        fileSystem,
        path,
        clientId: client.id,
      });
    }).pipe(
      Effect.provide(
        makeHarnessLayer({
          world,
          root,
          settings: {
            campaignImageGenerator: generator,
            // Any file that exists will do: the fake runner never starts it.
            campaignLocalGpuPython: process.execPath,
          },
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const person = { kind: "person" } as const;
const start = (scene: Scene, prompt = "A bouquet") =>
  scene.service.startJob({
    actor: person,
    kind: "image",
    clientId: scene.clientId,
    prompt,
    options: { aspectRatio: "1:1" },
    sourceThreadId: ThreadId.make("thread-1"),
  });

it.effect(
  "a finished local file is moved into the project folder and its work folder is removed",
  () =>
    scenario((scene) =>
      Effect.gen(function* () {
        const job = yield* start(scene);
        assert.strictEqual(job.connector, "local-gpu");
        assert.strictEqual(job.model, "lcm-dreamshaper-v7");
        assert.strictEqual(job.estimatedUsd, 0);
        assert.strictEqual(job.estimateNote, "Runs on this computer.");
        yield* scene.service.tick;
        const done = yield* scene.service.getJob(job.id);
        assert.strictEqual(done.status, "done", done.error);
        const relative = `campaigns/candid-studios/unsorted/generated/${job.id}.png`;
        assert.deepStrictEqual(done.resultPaths, [relative]);
        assert.strictEqual(
          yield* scene.fileSystem.readFileString(scene.path.join(scene.root, relative)),
          "PNGBYTES",
        );
        // No network call was made: the image never went through the https download path.
        assert.deepStrictEqual(yield* Ref.get(scene.world.calls), []);
        const processes = yield* Ref.get(scene.world.processes);
        assert.strictEqual(processes.length, 1);
        const out = flagValue(processes[0]?.args ?? [], "--out") ?? "";
        assert.strictEqual(yield* scene.fileSystem.exists(scene.path.dirname(out)), false);
      }),
    ),
);

it.effect("a failure from the script becomes the job's plain-words error", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      scene.world.program.current = () =>
        Effect.succeed(
          result(
            '{"ok":false,"reason":"The GPU has 3.3 GB free and this model needs about 8 GB. Text models are using the rest."}\n',
            1,
          ),
        );
      const job = yield* start(scene);
      yield* scene.service.tick;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(
        failed.error,
        "The GPU has 3.3 GB free and this model needs about 8 GB. Text models are using the rest.",
      );
    }),
  ),
);

it.effect("a result file that is not an image, or is not in the work folder, is not saved", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      const outside = scene.path.join(scene.root, "secret.png");
      yield* scene.fileSystem.writeFileString(outside, "SECRET");
      scene.world.program.current = () => Effect.succeed(result('{"ok":true}\n'));
      // The script claims success but wrote nothing.
      const missing = yield* start(scene);
      yield* scene.service.tick;
      const failedMissing = yield* scene.service.getJob(missing.id);
      assert.strictEqual(failedMissing.status, "failed");
      assert.include(
        failedMissing.error ?? "",
        "The graphics card made it, but it could not be saved",
      );
      assert.deepStrictEqual(failedMissing.resultPaths, []);
    }),
  ),
);

it.effect("local jobs run one at a time", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      let running = 0;
      let most = 0;
      scene.world.program.current = (input) =>
        Effect.gen(function* () {
          running += 1;
          most = Math.max(most, running);
          yield* Effect.yieldNow;
          running -= 1;
          return yield* writesImage(scene.fileSystem)(input);
        });
      const first = yield* start(scene, "One");
      const second = yield* start(scene, "Two");
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(first.id)).status, "done");
      assert.strictEqual((yield* scene.service.getJob(second.id)).status, "done");
      assert.strictEqual(most, 1);
      const prompts = (yield* Ref.get(scene.world.processes)).map((run) =>
        flagValue(run.args, "--prompt"),
      );
      assert.deepStrictEqual([...prompts].toSorted(), ["One", "Two"]);
    }),
  ),
);

it.effect("a local job found running after a restart is failed with nothing charged", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      const job = yield* start(scene);
      scene.world.program.current = () => Effect.never;
      yield* scene.jobs.claim(job.id);
      yield* scene.service.recover;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, GenerationService.INTERRUPTED_LOCAL_GPU);
      assert.strictEqual(
        failed.error,
        "Interrupted by a restart. Nothing was charged; start it again.",
      );
    }),
  ),
);

it.effect("settings: the card's fields are stored, bad paths are refused, video is refused", () =>
  scenario(
    (scene) =>
      Effect.gen(function* () {
        const set = yield* scene.service.setSettings({
          imageGenerator: "local-gpu",
          localGpuPython: " /home/me/venv/bin/python ",
          localGpuModel: "sdxl-base-1.0",
          localGpuModelsDir: "~/models",
        });
        assert.strictEqual(set.imageGenerator, "local-gpu");
        assert.deepStrictEqual(set.localGpu, {
          python: "/home/me/venv/bin/python",
          model: "sdxl-base-1.0",
          videoModel: "",
          modelsDir: "~/models",
          whenBusy: "fallback",
          windowStart: "",
          windowEnd: "",
        });
        const cleared = yield* scene.service.setSettings({
          localGpuPython: "",
          localGpuModel: "",
          localGpuModelsDir: "",
        });
        assert.deepStrictEqual(cleared.localGpu, {
          python: "",
          model: "",
          videoModel: "",
          modelsDir: "",
          whenBusy: "fallback",
          windowStart: "",
          windowEnd: "",
        });
        const folder = yield* scene.service.setSettings({ localGpuModel: "/models/my folder" });
        assert.strictEqual(folder.localGpu.model, "/models/my folder");

        const relative = yield* Effect.flip(
          scene.service.setSettings({ localGpuPython: "python3" }),
        );
        assert.include(relative.message, "must be a full path");
        const dir = yield* Effect.flip(scene.service.setSettings({ localGpuModelsDir: "../x" }));
        assert.include(dir.message, "must be a full path");
        const model = yield* Effect.flip(scene.service.setSettings({ localGpuModel: "a b;c" }));
        assert.include(model.message, "one of the presets");
        // The graphics card makes video too now; only a known video preset is accepted.
        const video = yield* scene.service.setSettings({ videoGenerator: "local-gpu" });
        assert.strictEqual(video.videoGenerator, "local-gpu");
        const badVideoModel = yield* Effect.flip(
          scene.service.setSettings({ localGpuVideoModel: "/models/my folder" }),
        );
        assert.include(badVideoModel.message, "video model must be one of: wan22-ti2v-5b");
        const goodVideoModel = yield* scene.service.setSettings({
          localGpuVideoModel: " wan22-ti2v-5b ",
        });
        assert.strictEqual(goodVideoModel.localGpu.videoModel, "wan22-ti2v-5b");
        yield* scene.service.setSettings({ localGpuVideoModel: "", videoGenerator: "none" });

        yield* scene.service.setSettings({ localGpuModel: "" });
        const noVideo = yield* Effect.flip(
          scene.service.startJob({
            actor: person,
            kind: "video",
            clientId: scene.clientId,
            prompt: "A cake",
            options: {},
          }),
        );
        assert.include(noVideo.message, "No video generator is set up");
      }),
    "none",
  ),
);

it.effect("test and download go to the script and return its lines", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      scene.world.program.current = (input) =>
        Effect.succeed(
          input.args.includes("--check")
            ? result(
                '{"ok":true,"lines":[{"ok":true,"text":"Graphics card: 3.3 GB free of 15.6 GB."}]}\n',
              )
            : result('{"ok":true,"bytes":4266993365,"seconds":115.9}\n'),
        );
      const check = yield* scene.service.test("local-gpu");
      assert.deepStrictEqual(check, {
        ok: true,
        notes: "OK: Graphics card: 3.3 GB free of 15.6 GB.",
      });
      const download = yield* scene.service.test("local-gpu", "download");
      assert.strictEqual(download.ok, true);
      assert.include(download.notes ?? "", "Downloaded 4.3 GB in 116 seconds.");
      const none = yield* scene.service.test("openrouter", "download");
      assert.deepStrictEqual(none, {
        ok: false,
        reason: "There is nothing to download for this generator.",
      });
    }),
  ),
);

const busyReply = (free: number, need: number) =>
  result(
    `{"ok":false,"busy":true,"freeGb":${free},"needGb":${need},"reason":"The GPU has ${free} GB free and this model needs about ${need} GB. Text models are using the rest."}\n`,
    1,
  );

const agentStart = (scene: Scene) =>
  scene.service.startJob({
    actor: { kind: "agent", threadId: ThreadId.make("thread-agent-1") },
    kind: "image",
    clientId: scene.clientId,
    prompt: "A bouquet",
    options: { aspectRatio: "1:1" },
  });

const WAIT = "Waiting for the graphics card: 3.3 GB free, this model needs 6.5 GB.";

it.effect("settings: the wait choice and the night window are stored and checked", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      const set = yield* scene.service.setSettings({
        localGpuWhenBusy: "wait",
        localGpuWindowStart: " 22:00 ",
        localGpuWindowEnd: "06:30",
      });
      assert.strictEqual(set.localGpu.whenBusy, "wait");
      assert.strictEqual(set.localGpu.windowStart, "22:00");
      assert.strictEqual(set.localGpu.windowEnd, "06:30");
      const half = yield* Effect.flip(scene.service.setSettings({ localGpuWindowEnd: "" }));
      assert.include(half.message, "Set both night window times");
      const bad = yield* Effect.flip(
        scene.service.setSettings({ localGpuWindowStart: "25:00", localGpuWindowEnd: "06:00" }),
      );
      assert.include(bad.message, "24-hour clock times");
      const cleared = yield* scene.service.setSettings({
        localGpuWindowStart: "",
        localGpuWindowEnd: "",
      });
      assert.strictEqual(cleared.localGpu.windowStart, "");
    }),
  ),
);

it.effect("fallback (the default) never asks the script to refuse a smaller model", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* start(scene);
      yield* scene.service.tick;
      const runs = yield* Ref.get(scene.world.processes);
      assert.notInclude(runs[0]?.args ?? [], "--no-fallback");
    }),
  ),
);

it.effect(
  "wait: a busy card leaves the job queued with a plain note, and it is tried again later",
  () =>
    scenario((scene) =>
      Effect.gen(function* () {
        yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
        scene.world.program.current = () => Effect.succeed(busyReply(3.3, 6.5));
        const job = yield* agentStart(scene);
        yield* scene.service.tick;
        const waiting = yield* scene.service.getJob(job.id);
        assert.strictEqual(waiting.status, "queued");
        assert.strictEqual(waiting.waitingNote, WAIT);
        assert.strictEqual(waiting.error, undefined);
        const first = yield* Ref.get(scene.world.processes);
        assert.include(first[0]?.args ?? [], "--no-fallback");
        assert.deepStrictEqual(yield* Ref.get(scene.world.told), []);

        // Ticks come every few seconds, but the card is only asked again after a few minutes.
        yield* scene.service.tick;
        assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 1);

        scene.world.program.current = writesImage(scene.fileSystem);
        yield* TestClock.adjust("4 minutes");
        yield* scene.service.tick;
        const done = yield* scene.service.getJob(job.id);
        assert.strictEqual(done.status, "done", done.error);
        assert.strictEqual(done.waitingNote, undefined);
        // The agent that asked is still told, once, when the job finally finishes.
        const told = yield* Ref.get(scene.world.told);
        assert.strictEqual(told.length, 1);
        assert.strictEqual(told[0]?.key, `generation:${job.id}:done`);
        assert.include(told[0]?.text ?? "", "finished and was saved to");
      }),
    ),
);

it.effect("a waiting job stays queued across a restart, and a restart does not fail it", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
      scene.world.program.current = () => Effect.succeed(busyReply(3.3, 6.5));
      const job = yield* start(scene);
      yield* scene.service.tick;
      yield* scene.service.recover;
      const after = yield* scene.service.getJob(job.id);
      assert.strictEqual(after.status, "queued");
      assert.strictEqual(after.waitingNote, WAIT);
      scene.world.program.current = writesImage(scene.fileSystem);
      yield* TestClock.adjust("4 minutes");
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "done");
    }),
  ),
);

it.effect("a waiting job can be cancelled and is then never run", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
      scene.world.program.current = () => Effect.succeed(busyReply(3.3, 6.5));
      const job = yield* start(scene);
      yield* scene.service.tick;
      const cancelled = yield* scene.service.cancelJob(job.id);
      assert.strictEqual(cancelled.status, "cancelled");
      assert.strictEqual(cancelled.waitingNote, undefined);
      yield* TestClock.adjust("10 minutes");
      yield* scene.service.tick;
      assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 1);
    }),
  ),
);

it.effect("a job that waited more than 24 hours gives up with a plain message", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
      scene.world.program.current = () => Effect.succeed(busyReply(3.3, 6.5));
      const job = yield* agentStart(scene);
      yield* scene.service.tick;
      yield* TestClock.adjust(`${LOCAL_GPU_WAIT_LIMIT_MS - 60_000} millis`);
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "queued");
      yield* TestClock.adjust("2 minutes");
      yield* scene.service.tick;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, GenerationService.GAVE_UP_WAITING);
      const told = yield* Ref.get(scene.world.told);
      assert.strictEqual(told.length, 1);
      assert.include(told[0]?.text ?? "", "failed");
    }),
  ),
);

it.effect("a real failure while waiting still fails the job at once", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
      scene.world.program.current = () =>
        Effect.succeed(
          result('{"ok":false,"reason":"This model has not been downloaded yet."}\n', 1),
        );
      const job = yield* start(scene);
      yield* scene.service.tick;
      const failed = yield* scene.service.getJob(job.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.error, "This model has not been downloaded yet.");
    }),
  ),
);

it.effect("quiet hours: outside the window the job waits; inside it runs", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      // The test clock starts at the epoch; read this computer's local time of day from it.
      // @effect-diagnostics-next-line globalDateInEffect:off
      const local = new Date(yield* Clock.currentTimeMillis);
      const minute = local.getHours() * 60 + local.getMinutes();
      const clock = (value: number) => {
        const wrapped = ((value % 1440) + 1440) % 1440;
        return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
      };
      const opens = clock(minute + 120);
      yield* scene.service.setSettings({
        localGpuWindowStart: opens,
        localGpuWindowEnd: clock(minute + 240),
      });
      const job = yield* start(scene);
      yield* scene.service.tick;
      const held = yield* scene.service.getJob(job.id);
      assert.strictEqual(held.status, "queued");
      assert.strictEqual(held.waitingNote, `Scheduled for tonight after ${opens}.`);
      assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 0);
      yield* TestClock.adjust("150 minutes");
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "done");
    }),
  ),
);

it.effect("other generators' jobs are not held up by a waiting graphics-card job", () =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ localGpuWhenBusy: "wait" });
      scene.world.program.current = () => Effect.succeed(busyReply(3.3, 6.5));
      const gpu = yield* start(scene);
      // A job of another generator is created straight in the store; the local pass must not touch it.
      const other = yield* scene.jobs.create({
        clientId: scene.clientId,
        kind: "image",
        connector: "openrouter",
        model: "x/y",
        prompt: "Other",
        options: { aspectRatio: "1:1" },
        status: "queued",
        estimatedUsd: 0,
        estimateNote: "",
        requestedBy: person,
      });
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(gpu.id)).status, "queued");
      assert.notStrictEqual((yield* scene.service.getJob(other.id)).status, "queued");
    }),
  ),
);

// Video from a still

const VIDEO_MODEL = "wan22-ti2v-5b";
const STILL_DIR = "campaigns/candid-studios/unsorted/generated";

/** A script that writes a small mp4 where it was told to, like the real video script. */
const writesVideo =
  (fileSystem: FileSystem.FileSystem): GenerationWorld["program"]["current"] =>
  (input) =>
    Effect.gen(function* () {
      const out = flagValue(input.args, "--out");
      if (out !== undefined) yield* Effect.orDie(fileSystem.writeFileString(out, "MP4BYTES"));
      return result(`{"ok":true,"path":"${out}","seconds":300}\n`);
    });

const videoScene = <E>(
  body: (scene: Scene) => Effect.Effect<void, E, CampaignStore.CampaignStore>,
) =>
  scenario((scene) =>
    Effect.gen(function* () {
      yield* scene.service.setSettings({ videoGenerator: "local-gpu" });
      scene.world.program.current = writesVideo(scene.fileSystem);
      yield* body(scene);
    }),
  );

const putStill = (scene: Scene, name = "still.png") =>
  Effect.gen(function* () {
    const directory = scene.path.join(scene.root, STILL_DIR);
    yield* scene.fileSystem.makeDirectory(directory, { recursive: true });
    yield* scene.fileSystem.writeFileString(scene.path.join(directory, name), "PNGBYTES");
    return `${STILL_DIR}/${name}`;
  });

const startVideo = (
  scene: Scene,
  options: Parameters<GenerationService.GenerationService["Service"]["startJob"]>[0]["options"],
  actor: Parameters<
    GenerationService.GenerationService["Service"]["startJob"]
  >[0]["actor"] = person,
) =>
  scene.service.startJob({
    actor,
    kind: "video",
    clientId: scene.clientId,
    prompt: "The barista hands over the cup",
    options,
    sourceThreadId: ThreadId.make("thread-1"),
  });

it.effect("a video job needs a still, in plain words, and never fetches a web address", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const none = yield* Effect.flip(startVideo(scene, {}));
      assert.strictEqual(
        none.message,
        "This computer makes video from a still image. Choose an image to start from.",
      );
      const blank = yield* Effect.flip(startVideo(scene, { firstFrame: "  " }));
      assert.include(blank.message, "Choose an image to start from");
      const web = yield* Effect.flip(
        startVideo(scene, { firstFrame: "https://example.com/still.png" }),
      );
      assert.include(web.message, "A web address cannot be used");
      const tilde = yield* Effect.flip(startVideo(scene, { firstFrame: "~/still.png" }));
      assert.include(tilde.message, "inside the thread's folder");
      const up = yield* Effect.flip(startVideo(scene, { firstFrame: "../outside.png" }));
      assert.include(up.message, "inside the thread's folder");
      const absoluteUp = yield* Effect.flip(
        startVideo(scene, { firstFrame: `${scene.root}/../outside.png` }),
      );
      assert.include(absoluteUp.message, "inside the thread's folder");
      assert.deepStrictEqual(yield* scene.jobs.byStatus("queued"), []);
      assert.deepStrictEqual(yield* Ref.get(scene.world.processes), []);
      assert.deepStrictEqual(yield* Ref.get(scene.world.calls), []);
    }),
  ),
);

it.effect("a video job checks the length against what the model makes", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      const long = yield* Effect.flip(
        startVideo(scene, { firstFrame: still, durationSeconds: 10 }),
      );
      assert.strictEqual(long.message, `${VIDEO_MODEL} makes 3 to 5 second videos.`);
      const hd = yield* Effect.flip(startVideo(scene, { firstFrame: still, resolution: "1080p" }));
      assert.strictEqual(hd.message, `${VIDEO_MODEL} offers 480p.`);
    }),
  ),
);

it.effect("a video is made from the still, saved as an mp4, and costs nothing", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      const job = yield* startVideo(scene, {
        firstFrame: still,
        aspectRatio: "9:16",
        durationSeconds: 4,
      });
      assert.strictEqual(job.connector, "local-gpu");
      assert.strictEqual(job.model, VIDEO_MODEL);
      assert.strictEqual(job.estimatedUsd, 0);
      assert.strictEqual(job.estimateNote, "Runs on this computer.");
      yield* scene.service.tick;
      const done = yield* scene.service.getJob(job.id);
      assert.strictEqual(done.status, "done", done.error);
      const relative = `${STILL_DIR}/${job.id}.mp4`;
      assert.deepStrictEqual(done.resultPaths, [relative]);
      assert.strictEqual(
        yield* scene.fileSystem.readFileString(scene.path.join(scene.root, relative)),
        "MP4BYTES",
      );
      const runs = yield* Ref.get(scene.world.processes);
      assert.strictEqual(runs.length, 1);
      const args = runs[0]?.args ?? [];
      assert.match(args[1] ?? "", /generate_video\.py$/);
      const real = yield* scene.fileSystem.realPath(scene.path.join(scene.root, still));
      assert.strictEqual(flagValue(args, "--image"), real);
      assert.strictEqual(flagValue(args, "--seconds"), "4");
      assert.strictEqual(flagValue(args, "--width"), "9");
      assert.strictEqual(flagValue(args, "--height"), "16");
      assert.strictEqual(flagValue(args, "--model"), VIDEO_MODEL);
      // Nothing went over the network and the work folder is gone.
      assert.deepStrictEqual(yield* Ref.get(scene.world.calls), []);
      const out = flagValue(args, "--out") ?? "";
      assert.strictEqual(yield* scene.fileSystem.exists(scene.path.dirname(out)), false);
    }),
  ),
);

it.effect("the still may be named by an absolute path inside the project folder", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      const real = yield* scene.fileSystem.realPath(scene.path.join(scene.root, still));
      const job = yield* startVideo(scene, { firstFrame: real });
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "done");
    }),
  ),
);

it.effect("a still outside the folder, or reached through a link, fails the job unread", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const elsewhere = `${scene.root}-elsewhere`;
      yield* scene.fileSystem.makeDirectory(elsewhere, { recursive: true });
      const secret = scene.path.join(elsewhere, "secret.png");
      yield* scene.fileSystem.writeFileString(secret, "SECRET");
      yield* putStill(scene); // makes the folder
      const link = scene.path.join(scene.root, STILL_DIR, "link.png");
      yield* scene.fileSystem.symlink(secret, link);
      const folderLink = scene.path.join(scene.root, "linked");
      yield* scene.fileSystem.symlink(elsewhere, folderLink);

      const viaFileLink = yield* startVideo(scene, { firstFrame: `${STILL_DIR}/link.png` });
      const viaFolderLink = yield* startVideo(scene, { firstFrame: "linked/secret.png" });
      const absoluteOutside = yield* startVideo(scene, { firstFrame: secret });
      const missing = yield* startVideo(scene, { firstFrame: `${STILL_DIR}/nothing.png` });
      const notImage = yield* startVideo(scene, { firstFrame: `${STILL_DIR}/notes.txt` });
      yield* scene.service.tick;
      for (const job of [viaFileLink, viaFolderLink, absoluteOutside]) {
        const failed = yield* scene.service.getJob(job.id);
        assert.strictEqual(failed.status, "failed");
        assert.strictEqual(failed.error, "The first frame must be inside the thread's folder.");
      }
      const gone = yield* scene.service.getJob(missing.id);
      assert.strictEqual(gone.error, "nothing.png was not found.");
      const wrong = yield* scene.service.getJob(notImage.id);
      assert.strictEqual(wrong.error, "The first frame must be a png, jpg or webp image.");
      // The program was never started for any of them.
      assert.deepStrictEqual(yield* Ref.get(scene.world.processes), []);
    }).pipe(
      Effect.ensuring(
        scene.fileSystem
          .remove(`${scene.root}-elsewhere`, { recursive: true, force: true })
          .pipe(Effect.ignore),
      ),
    ),
  ),
);

const finishedImage = (scene: Scene, overrides: { readonly clientId?: string } = {}) =>
  Effect.gen(function* () {
    const still = yield* putStill(scene, "made.png");
    const created = yield* scene.jobs.create({
      clientId: overrides.clientId ?? scene.clientId,
      kind: "image",
      connector: "local-gpu",
      model: "z-image-turbo",
      prompt: "A bouquet",
      options: { aspectRatio: "1:1" },
      status: "queued",
      estimatedUsd: 0,
      estimateNote: "",
      requestedBy: person,
      sourceThreadId: ThreadId.make("thread-1"),
    });
    yield* scene.jobs.claim(created.id);
    yield* scene.jobs.finish(created.id, { status: "done", resultPaths: [still] });
    return { id: created.id, still };
  });

it.effect("fromJobId starts from a finished image job's picture and is never stored", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const earlier = yield* finishedImage(scene);
      const job = yield* startVideo(scene, { firstFrameJobId: earlier.id });
      assert.strictEqual(job.options.firstFrame, earlier.still);
      assert.strictEqual("firstFrameJobId" in job.options, false);
      yield* scene.service.tick;
      const done = yield* scene.service.getJob(job.id);
      assert.strictEqual(done.status, "done", done.error);
      const both = yield* Effect.flip(
        startVideo(scene, { firstFrameJobId: earlier.id, firstFrame: earlier.still }),
      );
      assert.include(both.message, "not both");
    }),
  ),
);

it.effect("fromJobId refuses anything but a finished image job of the same client", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const queued = yield* scene.jobs.create({
        clientId: scene.clientId,
        kind: "image",
        connector: "local-gpu",
        model: "z-image-turbo",
        prompt: "Not yet",
        options: { aspectRatio: "1:1" },
        status: "needs-approval",
        estimatedUsd: 0,
        estimateNote: "",
        requestedBy: person,
      });
      const refusal = "A video can only start from a finished picture made for the same client.";
      const notDone = yield* Effect.flip(startVideo(scene, { firstFrameJobId: queued.id }));
      assert.strictEqual(notDone.message, refusal);

      const still = yield* putStill(scene);
      const clip = yield* scene.jobs.create({
        clientId: scene.clientId,
        kind: "video",
        connector: "local-gpu",
        model: VIDEO_MODEL,
        prompt: "A clip",
        options: { firstFrame: still },
        status: "queued",
        estimatedUsd: 0,
        estimateNote: "",
        requestedBy: person,
      });
      yield* scene.jobs.claim(clip.id);
      yield* scene.jobs.finish(clip.id, { status: "done", resultPaths: [`${STILL_DIR}/clip.mp4`] });
      const aVideo = yield* Effect.flip(startVideo(scene, { firstFrameJobId: clip.id }));
      assert.strictEqual(aVideo.message, refusal);

      const stores = yield* CampaignStore.CampaignStore;
      const other = yield* stores.upsertClient({
        name: "Someone Else",
        brandNotes: "",
        doNotSay: [],
        approvalMode: "report-when-done",
      });
      const theirs = yield* finishedImage(scene, { clientId: other.id });
      const crossClient = yield* Effect.flip(startVideo(scene, { firstFrameJobId: theirs.id }));
      assert.strictEqual(crossClient.message, refusal);

      const unknown = yield* Effect.flip(startVideo(scene, { firstFrameJobId: "no-such-job" }));
      assert.strictEqual(unknown.reason, "not_found");
      // An image job may not carry a first frame or a job id at all.
      const image = yield* Effect.flip(
        scene.service.startJob({
          actor: person,
          kind: "image",
          clientId: scene.clientId,
          prompt: "x",
          options: { firstFrameJobId: queued.id },
        }),
      );
      assert.include(image.message, "for video only");
    }),
  ),
);

it.effect("an image and a video never use the card at the same time", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      let running = 0;
      let most = 0;
      scene.world.program.current = (input) =>
        Effect.gen(function* () {
          running += 1;
          most = Math.max(most, running);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          running -= 1;
          return yield* (
            input.args[1]?.endsWith("generate_video.py") === true
              ? writesVideo(scene.fileSystem)
              : writesImage(scene.fileSystem)
          )(input);
        });
      const image = yield* start(scene, "Picture");
      const video = yield* startVideo(scene, { firstFrame: still });
      yield* Effect.all([scene.service.tick, scene.service.tick], { concurrency: 2 });
      assert.strictEqual((yield* scene.service.getJob(image.id)).status, "done");
      assert.strictEqual((yield* scene.service.getJob(video.id)).status, "done");
      assert.strictEqual(most, 1);
      assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 2);
    }),
  ),
);

it.effect("a busy card leaves a video waiting, whatever the busy setting, and tries again", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      // The default is "fallback" for images; a video has nothing smaller to fall back to.
      assert.strictEqual((yield* scene.service.settings).localGpu.whenBusy, "fallback");
      scene.world.program.current = () => Effect.succeed(busyReply(3.3, 7.5));
      const job = yield* startVideo(
        scene,
        { firstFrame: still },
        {
          kind: "agent",
          threadId: ThreadId.make("thread-agent-1"),
        },
      );
      yield* scene.service.tick;
      const waiting = yield* scene.service.getJob(job.id);
      assert.strictEqual(waiting.status, "queued");
      assert.strictEqual(
        waiting.waitingNote,
        "Waiting for the graphics card: 3.3 GB free, this model needs 7.5 GB.",
      );
      assert.deepStrictEqual(yield* Ref.get(scene.world.told), []);
      // Asked again only after a few minutes.
      yield* scene.service.tick;
      assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 1);
      scene.world.program.current = writesVideo(scene.fileSystem);
      yield* TestClock.adjust("4 minutes");
      yield* scene.service.tick;
      const done = yield* scene.service.getJob(job.id);
      assert.strictEqual(done.status, "done", done.error);
      const told = yield* Ref.get(scene.world.told);
      assert.strictEqual(told.length, 1);
      assert.include(told[0]?.text ?? "", ".mp4");
    }),
  ),
);

it.effect("the night window holds a video back until it opens", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      // @effect-diagnostics-next-line globalDateInEffect:off
      const local = new Date(yield* Clock.currentTimeMillis);
      const minute = local.getHours() * 60 + local.getMinutes();
      const clock = (value: number) => {
        const wrapped = ((value % 1440) + 1440) % 1440;
        return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
      };
      const opens = clock(minute + 120);
      yield* scene.service.setSettings({
        localGpuWindowStart: opens,
        localGpuWindowEnd: clock(minute + 240),
      });
      const job = yield* startVideo(scene, { firstFrame: still });
      yield* scene.service.tick;
      const held = yield* scene.service.getJob(job.id);
      assert.strictEqual(held.status, "queued");
      assert.strictEqual(held.waitingNote, `Scheduled for tonight after ${opens}.`);
      assert.strictEqual((yield* Ref.get(scene.world.processes)).length, 0);
      yield* TestClock.adjust("150 minutes");
      yield* scene.service.tick;
      assert.strictEqual((yield* scene.service.getJob(job.id)).status, "done");
    }),
  ),
);

it.effect("a video that takes too long, or whose file is wrong, fails in plain words", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      const still = yield* putStill(scene);
      scene.world.program.current = () =>
        Effect.fail(
          new ProcessRunner.ProcessTimeoutError({
            command: "python",
            argumentCount: 0,
            timeoutMs: 1_800_000,
          }),
        );
      const slow = yield* startVideo(scene, { firstFrame: still });
      yield* scene.service.tick;
      assert.strictEqual(
        (yield* scene.service.getJob(slow.id)).error,
        "The video took longer than 30 minutes, so it was stopped. Nothing was charged.",
      );

      // The script claims success but wrote a picture, not a video.
      scene.world.program.current = (input) =>
        Effect.gen(function* () {
          const out = flagValue(input.args, "--out") ?? "";
          yield* Effect.orDie(
            scene.fileSystem.writeFileString(
              scene.path.join(scene.path.dirname(out), "video.png"),
              "x",
            ),
          );
          return result('{"ok":true}\n');
        });
      const wrong = yield* startVideo(scene, { firstFrame: still });
      yield* scene.service.tick;
      const failed = yield* scene.service.getJob(wrong.id);
      assert.strictEqual(failed.status, "failed");
      assert.include(failed.error ?? "", "The graphics card made it, but it could not be saved");
    }),
  ),
);

it.effect("test and download for video go to the video script and model", () =>
  videoScene((scene) =>
    Effect.gen(function* () {
      scene.world.program.current = (input) =>
        Effect.succeed(
          input.args.includes("--check")
            ? result('{"ok":true,"lines":[{"ok":true,"text":"Enough memory is free."}]}\n')
            : result('{"ok":true,"bytes":34200000000,"seconds":900}\n'),
        );
      const check = yield* scene.service.test("local-gpu", undefined, "video");
      assert.deepStrictEqual(check, { ok: true, notes: "OK: Enough memory is free." });
      const download = yield* scene.service.test("local-gpu", "download", "video");
      assert.include(download.notes ?? "", "Downloaded 34.2 GB in 900 seconds.");
      const runs = yield* Ref.get(scene.world.processes);
      for (const run of runs) {
        assert.match(run.args[1] ?? "", /generate_video\.py$/);
        assert.include(run.args, `--model=${VIDEO_MODEL}`);
      }
    }),
  ),
);
