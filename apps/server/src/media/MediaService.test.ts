// @effect-diagnostics nodeBuiltinImport:off - ffmpeg makes the test clip and the symlink case needs a real link.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect, beforeAll, afterAll } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as MediaService from "./MediaService.ts";

const ffmpegAvailable = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

const TestLayer = MediaService.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-media-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

let workspace = "";
let outside = "";

const run = (args: string[]) => {
  const result = NodeChildProcess.spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
};

beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-media-ws-")),
  );
  outside = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-media-out-")),
  );
  if (!ffmpegAvailable) return;
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=3:size=320x180:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    NodePath.join(workspace, "clip.mp4"),
  ]);
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=200x100:rate=1",
    "-frames:v",
    "1",
    NodePath.join(workspace, "still.png"),
  ]);
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=1",
    "-frames:v",
    "1",
    NodePath.join(outside, "secret.png"),
  ]);
  NodeFS.symlinkSync(NodePath.join(outside, "secret.png"), NodePath.join(workspace, "link.png"));
  NodeFS.writeFileSync(NodePath.join(workspace, "notes.txt"), "hello");
  NodeFS.writeFileSync(NodePath.join(workspace, "broken.mp4"), "not a video");
  NodeFS.writeFileSync(
    NodePath.join(workspace, "playlist.mp4"),
    "ffconcat version 1.0\nfile 'clip.mp4'\n",
  );
});

afterAll(() => {
  NodeFS.rmSync(workspace, { recursive: true, force: true });
  NodeFS.rmSync(outside, { recursive: true, force: true });
});

const jpegStart = (base64: string) => Buffer.from(base64, "base64").subarray(0, 3).toString("hex");

describe.skipIf(!ffmpegAvailable)("MediaService with ffmpeg", () => {
  it.layer(TestLayer, { excludeTestServices: true })("service", (it) => {
    it.effect("probes a video", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const probe = yield* media.probe({ cwd: workspace, relativePath: "clip.mp4" });
        expect(probe).toMatchObject({
          kind: "video",
          width: 320,
          height: 180,
          hasAudio: true,
          codec: "h264",
        });
        expect(probe.durationSeconds).toBeGreaterThan(2.5);
        expect(probe.fps).toBe(10);
      }),
    );

    it.effect("probes an image", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const probe = yield* media.probe({ cwd: workspace, relativePath: "still.png" });
        expect(probe).toMatchObject({
          kind: "image",
          width: 200,
          height: 100,
          durationSeconds: null,
        });
      }),
    );

    it.effect("returns frames with a box drawn and caches them", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const input = {
          cwd: workspace,
          relativePath: "clip.mp4",
          at: [0.5, 1.5, 99],
          box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
          maxEdge: 160,
        };
        const first = yield* media.frames(input);
        expect(first.frames).toHaveLength(3);
        expect(first.frames.map((frame) => frame.at)).toEqual([0.5, 1.5, 2.8]);
        for (const frame of first.frames) {
          expect(jpegStart(frame.base64)).toBe("ffd8ff");
          expect(frame).toMatchObject({ width: 160, height: 90 });
        }
        const plain = yield* media.frames({ ...input, box: undefined, at: [0.5] });
        expect(plain.frames[0]?.base64).not.toBe(first.frames[0]?.base64);
        const second = yield* media.frames(input);
        expect(second.frames[0]?.base64).toBe(first.frames[0]?.base64);
      }),
    );

    it.effect("returns the picture itself for an image, scaled to the edge", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const result = yield* media.frames({
          cwd: workspace,
          relativePath: "still.png",
          at: [0],
          box: { x: 0, y: 0, width: 1, height: 1 },
          maxEdge: 100,
        });
        expect(result.frames[0]).toMatchObject({ width: 100, height: 50 });
      }),
    );

    it.effect("makes a thumbnail strip", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const result = yield* media.thumbnails({
          cwd: workspace,
          relativePath: "clip.mp4",
          count: 6,
        });
        expect(result.frames).toHaveLength(6);
        expect(result.frames[0]?.width).toBe(160);
        expect(result.frames[5]?.at).toBeGreaterThan(2);
      }),
    );

    it.effect("refuses paths outside the folder", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const traversal = yield* media
          .probe({
            cwd: workspace,
            relativePath: "../" + NodePath.basename(outside) + "/secret.png",
          })
          .pipe(Effect.flip);
        expect(traversal.reason).toBe("outside_workspace");
        const absolute = yield* media
          .probe({ cwd: workspace, relativePath: NodePath.join(outside, "secret.png") })
          .pipe(Effect.flip);
        expect(absolute.reason).toBe("outside_workspace");
      }),
    );

    it.effect("refuses a symlink that leaves the folder", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const error = yield* media
          .probe({ cwd: workspace, relativePath: "link.png" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("outside_workspace");
      }),
    );

    it.effect("refuses other file types and missing files", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const text = yield* media
          .probe({ cwd: workspace, relativePath: "notes.txt" })
          .pipe(Effect.flip);
        expect(text.reason).toBe("unsupported_type");
        const missing = yield* media
          .probe({ cwd: workspace, relativePath: "nope.mp4" })
          .pipe(Effect.flip);
        expect(missing.reason).toBe("not_found");
      }),
    );

    it.effect("reports a file ffprobe cannot read", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const error = yield* media
          .probe({ cwd: workspace, relativePath: "broken.mp4" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("tool_failed");
      }),
    );

    it.effect("refuses a playlist saved with a video file name", () =>
      Effect.gen(function* () {
        const media = yield* MediaService.MediaService;
        const probeError = yield* media
          .probe({ cwd: workspace, relativePath: "playlist.mp4" })
          .pipe(Effect.flip);
        expect(probeError.reason).toBe("tool_failed");
      }),
    );
  });
});

describe("MediaService without ffmpeg", () => {
  it.layer(TestLayer, { excludeTestServices: true })("missing tool", (it) => {
    it.effect("names the fix when the executable cannot start", () =>
      Effect.gen(function* () {
        const original = process.env.PATH;
        process.env.PATH = "";
        try {
          const media = yield* MediaService.MediaService;
          const error = yield* media
            .probe({ cwd: workspace, relativePath: "clip.mp4" })
            .pipe(Effect.flip);
          // The file may be missing here when ffmpeg was unavailable to make it; either way no crash.
          expect(["tool_missing", "not_found"]).toContain(error.reason);
          if (error.reason === "tool_missing") expect(error.message).toContain("Install ffmpeg");
        } finally {
          process.env.PATH = original;
        }
      }),
    );
  });
});
