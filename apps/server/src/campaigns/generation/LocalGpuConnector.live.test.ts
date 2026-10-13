import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../../processRunner.ts";
import { makeLocalGpuConnector } from "./LocalGpuConnector.ts";
import { locateLocalGpuScript } from "./localGpuScript.ts";

// Makes a real image on this computer's graphics card, so it needs the small preset already
// downloaded and enough free memory. Run it with LOCALGPU_LIVE=1 and LOCALGPU_PYTHON set to a
// Python that has PyTorch and diffusers. LOCALGPU_OUT (optional) keeps the picture in that folder.
const live = process.env.LOCALGPU_LIVE === "1";

it.effect.skipIf(!live)(
  "the connector makes a real image with the small preset",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const workDir = yield* fileSystem.makeTempDirectoryScoped();
      const connector = makeLocalGpuConnector({
        runner,
        fileSystem,
        path,
        homeDir: NodeOS.homedir(),
        config: Effect.succeed({
          python: process.env.LOCALGPU_PYTHON ?? "",
          model: "",
          modelsDir: "",
          whenBusy: "fallback",
        }),
        script: locateLocalGpuScript(fileSystem, path),
      });

      const check = yield* connector.test();
      assert.strictEqual(check.ok, true, check.notes);

      const started = yield* connector.start({
        kind: "image",
        model: "lcm-dreamshaper-v7",
        prompt: "A warm bakery counter with fresh sourdough loaves, soft morning light",
        options: { aspectRatio: "16:9" },
        name: "live",
        workDir,
      });
      assert.strictEqual(started.kind, "finished");
      const file = started.kind === "finished" ? started.files?.[0] : undefined;
      assert.isString(file);
      const bytes = yield* fileSystem.readFile(file ?? "");
      // A PNG starts with these eight bytes.
      assert.deepStrictEqual(
        bytes.slice(0, 8),
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      );
      const keep = process.env.LOCALGPU_OUT;
      if (keep !== undefined && keep !== "") yield* fileSystem.writeFile(keep, bytes);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  { timeout: 15 * 60 * 1000 },
);

// Makes a real 3 second video from a still, so it needs the video model downloaded and about 7.5 GB
// of free graphics memory. Run it with LOCALGPU_VIDEO_LIVE=1, LOCALGPU_STILL set to a png, jpg or
// webp, and LOCALGPU_PYTHON set as above. LOCALGPU_OUT (optional) keeps the video at that path.
const liveVideo = process.env.LOCALGPU_VIDEO_LIVE === "1";

it.effect.skipIf(!liveVideo)(
  "the connector makes a real video from a still with the video preset",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      const workDir = yield* fileSystem.makeTempDirectoryScoped();
      const connector = makeLocalGpuConnector({
        runner,
        fileSystem,
        path,
        homeDir: NodeOS.homedir(),
        config: Effect.succeed({
          python: process.env.LOCALGPU_PYTHON ?? "",
          model: "",
          modelsDir: "",
          whenBusy: "fallback",
        }),
        script: locateLocalGpuScript(fileSystem, path),
        videoScript: locateLocalGpuScript(fileSystem, path, undefined, "generate_video.py"),
      });

      const check = yield* connector.test("video");
      assert.strictEqual(check.ok, true, check.notes);

      const started = yield* connector.start({
        kind: "video",
        model: "wan22-ti2v-5b",
        prompt: "Slow push in, steam rises gently from the coffee, soft light shifts",
        options: { aspectRatio: "1:1", durationSeconds: 3 },
        firstFramePath: process.env.LOCALGPU_STILL ?? "",
        name: "live",
        workDir,
      });
      assert.strictEqual(started.kind, "finished");
      const file = started.kind === "finished" ? started.files?.[0] : undefined;
      assert.isString(file);
      const bytes = yield* fileSystem.readFile(file ?? "");
      // An mp4 has "ftyp" at byte 4.
      assert.strictEqual(new TextDecoder().decode(bytes.slice(4, 8)), "ftyp");
      const keep = process.env.LOCALGPU_OUT;
      if (keep !== undefined && keep !== "") yield* fileSystem.writeFile(keep, bytes);
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  { timeout: 40 * 60 * 1000 },
);
