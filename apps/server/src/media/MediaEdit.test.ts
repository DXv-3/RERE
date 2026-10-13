// @effect-diagnostics nodeBuiltinImport:off - ffmpeg makes the test clips and the checks read real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as MediaEdit from "./MediaEdit.ts";
import { toEditRequest } from "./MediaEdit.ts";
import { assTime, buildCaptionsFilter, buildAss, sanitizeCaptionText } from "./MediaEditFfmpeg.ts";
import * as MediaService from "./MediaService.ts";

const ffmpegAvailable = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

const TestLayer = MediaEdit.layer.pipe(
  Layer.provideMerge(MediaService.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-media-edit-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

let workspace = "";
let outside = "";

const run = (args: string[]) => {
  const result = NodeChildProcess.spawnSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
};

const video = (target: string, source: string, extra: string[] = []) =>
  run([
    "-f",
    "lavfi",
    "-i",
    source,
    ...extra,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...(extra.length > 0 ? ["-c:a", "aac", "-shortest"] : []),
    target,
  ]);

beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-edit-ws-")),
  );
  outside = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-edit-out-")));
  if (!ffmpegAvailable) return;
  // 3 s, 320x180 at 10 fps, with sound.
  video(NodePath.join(workspace, "clip.mp4"), "testsrc=duration=3:size=320x180:rate=10", [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
  ]);
  // 2 s, a different size and rate, no sound.
  video(NodePath.join(workspace, "other.mp4"), "testsrc2=duration=2:size=160x120:rate=25");
  run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=200x100:rate=1",
    "-frames:v",
    "1",
    NodePath.join(workspace, "still.png"),
  ]);
  NodeFS.mkdirSync(NodePath.join(workspace, "sub"));
  NodeFS.copyFileSync(NodePath.join(workspace, "clip.mp4"), NodePath.join(outside, "secret.mp4"));
  NodeFS.symlinkSync(NodePath.join(outside, "secret.mp4"), NodePath.join(workspace, "link.mp4"));
  NodeFS.writeFileSync(
    NodePath.join(workspace, "playlist.mp4"),
    "ffconcat version 1.0\nfile 'clip.mp4'\n",
  );
  NodeFS.writeFileSync(NodePath.join(workspace, "notes.txt"), "hello");
});

afterAll(() => {
  NodeFS.rmSync(workspace, { recursive: true, force: true });
  NodeFS.rmSync(outside, { recursive: true, force: true });
});

const meanBrightness = (file: string, at: number): number => {
  // Averages one frame's luma; a burned-in caption changes it.
  const result = NodeChildProcess.spawnSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(at),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale=64:36,format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  const bytes = result.stdout;
  return bytes.reduce((sum, value) => sum + value, 0) / Math.max(1, bytes.length);
};

describe("edit parameters", () => {
  it("names what each operation is missing", () => {
    const reason = (input: Parameters<typeof toEditRequest>[0]) => {
      const parsed = toEditRequest(input);
      return "error" in parsed ? parsed.error.message : "ok";
    };
    expect(reason({ operation: "trim", file: "a.mp4", start: 5, end: 2 })).toContain(
      "end after start",
    );
    expect(reason({ operation: "join", files: ["a.mp4"] })).toContain("2 to 10 files");
    expect(
      reason({ operation: "join", files: Array.from({ length: 11 }, () => "a.mp4") }),
    ).toContain("2 to 10");
    expect(reason({ operation: "resize", file: "a.mp4" })).toContain("vertical");
    expect(reason({ operation: "captions", file: "a.mp4", captions: [] })).toContain("1 to 200");
    expect(
      reason({
        operation: "captions",
        file: "a.mp4",
        captions: Array.from({ length: 201 }, () => ({ start: 0, end: 1, text: "x" })),
      }),
    ).toContain("1 to 200");
    expect(
      reason({
        operation: "captions",
        file: "a.mp4",
        captions: [{ start: 0, end: 1, text: "x".repeat(201) }],
      }),
    ).toContain("1 to 200 characters");
    expect(reason({ operation: "poster", file: "a.mp4" })).toContain("needs at");
    expect(reason({ operation: "mute" })).toContain("needs file");
    expect(reason({ operation: "resize", file: "a.mp4", shape: "square" })).toBe("ok");
  });
});

describe("caption text", () => {
  it("is one plain line of text with no way to start a tag or an escape", () => {
    expect(sanitizeCaptionText("a {\\pos(1,1)}b \\N c %{expand}")).toBe(
      "a (/pos(1,1))b /N c %(expand)",
    );
    expect(sanitizeCaptionText("one\r\ntwo\n\n three \u0007")).toBe("one\\Ntwo\\Nthree");
    const ass = buildAss({
      width: 320,
      height: 180,
      captions: [{ start: 0, end: 1, text: "x\n[Events]\nDialogue: 0,0:00:00.00" }],
    });
    // The text cannot start a new section or a new line of the script.
    expect(ass.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(1);
    expect(ass.split("\n").filter((line) => line === "[Events]")).toHaveLength(1);
  });

  it("formats times and refuses an unsafe file name in the filter", () => {
    expect(assTime(3661.256)).toBe("1:01:01.26");
    expect(buildCaptionsFilter("captions-ab12.ass")).toContain(
      "subtitles=filename=captions-ab12.ass",
    );
    expect(() => buildCaptionsFilter("a:b'.ass")).toThrow();
    expect(() => buildCaptionsFilter("x.ass,drawtext=text=hi")).toThrow();
  });
});

describe.skipIf(!ffmpegAvailable)("MediaEdit with ffmpeg", () => {
  it.layer(TestLayer, { excludeTestServices: true })("service", (it) => {
    const edit = (request: MediaEdit.MediaEditRequest) =>
      MediaEdit.MediaEdit.pipe(Effect.flatMap((service) => service.edit(workspace, request)));

    it.effect("trims to the exact range and never overwrites", () =>
      Effect.gen(function* () {
        const first = yield* edit({ operation: "trim", file: "clip.mp4", start: 0.5, end: 2 });
        expect(first.file).toBe("clip.trim-1.mp4");
        expect(first.reencoded).toBe(true);
        expect(first.probe?.durationSeconds).toBeGreaterThan(1.3);
        expect(first.probe?.durationSeconds).toBeLessThan(1.7);
        expect(first.probe).toMatchObject({ width: 320, height: 180, hasAudio: true });
        const second = yield* edit({ operation: "trim", file: "clip.mp4", start: 0, end: 1 });
        expect(second.file).toBe("clip.trim-2.mp4");
        expect(NodeFS.existsSync(NodePath.join(workspace, "clip.trim-1.mp4"))).toBe(true);
        const bytes = NodeFS.statSync(NodePath.join(workspace, "clip.trim-1.mp4")).size;
        yield* edit({ operation: "trim", file: "clip.mp4", start: 1, end: 9 });
        expect(NodeFS.statSync(NodePath.join(workspace, "clip.trim-1.mp4")).size).toBe(bytes);
      }),
    );

    it.effect("refuses a start past the end", () =>
      Effect.gen(function* () {
        const error = yield* edit({ operation: "trim", file: "clip.mp4", start: 10, end: 12 }).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("invalid_request");
      }),
    );

    it.effect("joins clips of different size, rate and sound into one", () =>
      Effect.gen(function* () {
        const result = yield* edit({ operation: "join", files: ["clip.mp4", "other.mp4"] });
        expect(result.file).toBe("clip.join-1.mp4");
        expect(result.reencoded).toBe(true);
        expect(result.notes.join(" ")).toContain("Re-encoded");
        expect(result.probe).toMatchObject({ width: 320, height: 180, hasAudio: true });
        expect(result.probe?.durationSeconds).toBeGreaterThan(4.6);
        expect(result.probe?.durationSeconds).toBeLessThan(5.4);
        expect(result.probe?.fps).toBe(10);
        const silentOnly = yield* edit({ operation: "join", files: ["other.mp4", "other.mp4"] });
        expect(silentOnly.probe?.hasAudio).toBe(false);
      }),
    );

    it.effect("resizes a video to every platform shape, cropped or padded", () =>
      Effect.gen(function* () {
        const shapes = {
          vertical: [1080, 1920],
          square: [1080, 1080],
          landscape: [1920, 1080],
          "portrait-4x5": [1080, 1350],
        } as const;
        for (const [shape, [width, height]] of Object.entries(shapes) as Array<
          [keyof typeof shapes, readonly [number, number]]
        >) {
          const cropped = yield* edit({
            operation: "resize",
            file: "clip.mp4",
            shape,
            fit: "crop",
          });
          expect(cropped.probe).toMatchObject({ width, height, hasAudio: true });
        }
        const padded = yield* edit({
          operation: "resize",
          file: "clip.mp4",
          shape: "vertical",
          fit: "pad",
        });
        expect(padded.probe).toMatchObject({ width: 1080, height: 1920 });
        expect(padded.notes.join(" ")).toContain("blurred");
      }),
    );

    it.effect("resizes an image and keeps its type", () =>
      Effect.gen(function* () {
        const result = yield* edit({
          operation: "resize",
          file: "still.png",
          shape: "portrait-4x5",
          fit: "pad",
        });
        expect(result.file).toBe("still.resize-1.png");
        expect(result.probe).toMatchObject({ kind: "image", width: 1080, height: 1350 });
      }),
    );

    it.effect("burns in captions that change the picture only while shown", () =>
      Effect.gen(function* () {
        const result = yield* edit({
          operation: "captions",
          file: "clip.mp4",
          captions: [{ start: 1, end: 2, text: "Hello world. This is a caption" }],
        });
        expect(result.file).toBe("clip.captions-1.mp4");
        expect(result.probe).toMatchObject({ width: 320, height: 180, hasAudio: true });
        const plain = NodePath.join(workspace, "clip.mp4");
        const captioned = NodePath.join(workspace, result.file);
        const shown = Math.abs(meanBrightness(captioned, 1.5) - meanBrightness(plain, 1.5));
        const hidden = Math.abs(meanBrightness(captioned, 0.3) - meanBrightness(plain, 0.3));
        expect(shown).toBeGreaterThan(hidden * 2 + 0.01);
      }),
    );

    it.effect("treats caption text as text: quotes, colons, backslashes, newlines, %{...}", () =>
      Effect.gen(function* () {
        const nasty = [
          `It's "quoted": 10:30, a\\b\\N{\\fs200}c`,
          "line one\nline two",
          "%{expand:hi} %{pts} ';drawtext=text=INJECTED,[x]",
          "a,b;c=d[e]f",
        ];
        const result = yield* edit({
          operation: "captions",
          file: "clip.mp4",
          captions: nasty.map((text, index) => ({
            start: index * 0.6,
            end: index * 0.6 + 0.5,
            text,
          })),
        });
        expect(result.probe?.durationSeconds).toBeGreaterThan(2.5);
        // No captions file is left behind in the cache.
        const config = yield* ServerConfig.ServerConfig;
        const leftover = NodeFS.readdirSync(NodePath.join(config.stateDir, "media-cache")).filter(
          (name) => name.endsWith(".ass"),
        );
        expect(leftover).toEqual([]);
      }),
    );

    it.effect("mutes a video, copying the picture", () =>
      Effect.gen(function* () {
        const result = yield* edit({ operation: "mute", file: "clip.mp4" });
        expect(result.file).toBe("clip.mute-1.mp4");
        expect(result.reencoded).toBe(false);
        expect(result.probe).toMatchObject({ hasAudio: false, codec: "h264", width: 320 });
      }),
    );

    it.effect("pulls the audio into an m4a and refuses a silent video", () =>
      Effect.gen(function* () {
        const result = yield* edit({ operation: "extract-audio", file: "clip.mp4" });
        expect(result.file).toBe("clip.extract-audio-1.m4a");
        expect(result.probe).toBeNull();
        expect(result.audio?.durationSeconds).toBeGreaterThan(2.5);
        const probed = NodeChildProcess.spawnSync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name",
          "-of",
          "csv=p=0",
          NodePath.join(workspace, result.file),
        ]).stdout.toString();
        expect(probed.trim()).toBe("aac,audio");
        const silent = yield* edit({ operation: "extract-audio", file: "other.mp4" }).pipe(
          Effect.flip,
        );
        expect(silent.reason).toBe("invalid_request");
      }),
    );

    it.effect("saves a still as a jpg, clamping a time past the end", () =>
      Effect.gen(function* () {
        const result = yield* edit({ operation: "poster", file: "clip.mp4", at: 99 });
        expect(result.file).toBe("clip.poster-1.jpg");
        expect(result.probe).toMatchObject({ kind: "image", width: 320, height: 180 });
        const head = NodeFS.readFileSync(NodePath.join(workspace, result.file)).subarray(0, 3);
        expect(head.toString("hex")).toBe("ffd8ff");
      }),
    );

    it.effect("works on a file in a folder and puts the copy beside it", () =>
      Effect.gen(function* () {
        NodeFS.copyFileSync(
          NodePath.join(workspace, "clip.mp4"),
          NodePath.join(workspace, "sub", "a b.mp4"),
        );
        const result = yield* edit({ operation: "mute", file: "sub/a b.mp4" });
        expect(result.file).toBe("sub/a b.mute-1.mp4");
      }),
    );

    it.effect("refuses paths outside the folder, including a symlink out", () =>
      Effect.gen(function* () {
        const traversal = yield* edit({
          operation: "mute",
          file: `../${NodePath.basename(outside)}/secret.mp4`,
        }).pipe(Effect.flip);
        expect(traversal.reason).toBe("outside_workspace");
        const absolute = yield* edit({
          operation: "mute",
          file: NodePath.join(outside, "secret.mp4"),
        }).pipe(Effect.flip);
        expect(absolute.reason).toBe("outside_workspace");
        const link = yield* edit({ operation: "mute", file: "link.mp4" }).pipe(Effect.flip);
        expect(link.reason).toBe("outside_workspace");
        const joined = yield* edit({ operation: "join", files: ["clip.mp4", "link.mp4"] }).pipe(
          Effect.flip,
        );
        expect(joined.reason).toBe("outside_workspace");
        expect(NodeFS.readdirSync(outside)).toEqual(["secret.mp4"]);
      }),
    );

    it.effect("refuses a playlist saved as a video, and other kinds of file", () =>
      Effect.gen(function* () {
        const playlist = yield* edit({
          operation: "trim",
          file: "playlist.mp4",
          start: 0,
          end: 1,
        }).pipe(Effect.flip);
        expect(playlist.reason).toBe("tool_failed");
        const text = yield* edit({ operation: "mute", file: "notes.txt" }).pipe(Effect.flip);
        expect(text.reason).toBe("unsupported_type");
        const image = yield* edit({ operation: "mute", file: "still.png" }).pipe(Effect.flip);
        expect(image.reason).toBe("invalid_request");
        const missing = yield* edit({ operation: "mute", file: "nope.mp4" }).pipe(Effect.flip);
        expect(missing.reason).toBe("not_found");
        // Nothing half-made is left from a refused input.
        expect(
          NodeFS.readdirSync(workspace).filter((name) => name.startsWith("playlist.")),
        ).toEqual(["playlist.mp4"]);
      }),
    );

    it.effect("keeps the whole join away from a playlist hidden among the inputs", () =>
      Effect.gen(function* () {
        const error = yield* edit({ operation: "join", files: ["clip.mp4", "playlist.mp4"] }).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("tool_failed");
      }),
    );
  });
});
