// @effect-diagnostics nodeBuiltinImport:off - local synthetic media fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeAll, afterAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as MediaService from "../../media/MediaService.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as StudioMedia from "./StudioMedia.ts";

const available = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;
let workspace = "";
let originals: Buffer[] = [];
const ffmpeg = (args: string[]) => {
  const result = NodeChildProcess.spawnSync("ffmpeg", ["-v", "error", "-threads", "2", ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
};
beforeAll(() => {
  workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-media-test-"));
  if (!available) return;
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=black:size=160x90:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    NodePath.join(workspace, "clip.mp4"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=black:size=90x160",
    "-frames:v",
    "1",
    NodePath.join(workspace, "still.png"),
  ]);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=0.4",
    NodePath.join(workspace, "voice.mp3"),
  ]);
  originals = ["clip.mp4", "still.png", "voice.mp3"].map((name) =>
    NodeFS.readFileSync(NodePath.join(workspace, name)),
  );
});
afterAll(() => NodeFS.rmSync(workspace, { recursive: true, force: true }));
function setup(status = 200, configured = true, mode: "audio" | "hang" | "invalid" = "audio") {
  const requested = Deferred.makeUnsafe<void>();
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    if (mode === "hang")
      return Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never));
    expect(request.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
    expect(request.headers["xi-api-key"]).toBe("fake-test-key");
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag === "Uint8Array")
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        text: "Hello",
        model_id: "eleven_multilingual_v2",
      });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          status === 200
            ? new Uint8Array(mode === "invalid" ? [1, 2, 3] : originals[2]!)
            : "private provider diagnostic",
          { status, headers: { "content-type": "audio/mpeg" } },
        ),
      ),
    );
  });
  const secrets = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (key) => {
      expect(key).toBe("workbench-voice-elevenlabs");
      return Effect.succeed(
        configured ? Option.some(new TextEncoder().encode("fake-test-key")) : Option.none(),
      );
    },
    set: () => Effect.die("unexpected"),
    remove: () => Effect.die("unexpected"),
    create: () => Effect.die("unexpected"),
    getOrCreateRandom: () => Effect.die("unexpected"),
  });
  const layer = StudioMedia.layer.pipe(
    Layer.provide(secrets),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(MediaService.layer),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-config-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, requested, calls: () => calls };
}
const brightness = (file: string, at: number) => {
  const bytes = ffmpeg([
    "-ss",
    String(at),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "scale=160:90,format=gray",
    "-f",
    "rawvideo",
    "-",
  ]);
  return bytes.reduce((a, b) => a + b, 0) / bytes.length;
};
describe.skipIf(!available)("StudioMedia local assembly and saved narration", () => {
  it.effect(
    "assembles image/video scenes with timed captions, audio, correct duration and untouched originals",
    () => {
      const s = setup();
      return Effect.gen(function* () {
        const studio = yield* StudioMedia.StudioMedia;
        const result = yield* studio.render({
          cwd: workspace,
          scenes: [
            { file: "clip.mp4", start: 0.2, durationSeconds: 0.5, onScreenText: "HELLO WORLD" },
            {
              file: "still.png",
              durationSeconds: 0.5,
              captions: [{ start: 0.25, end: 0.5, text: "SECOND SCENE" }],
            },
          ],
          aspectRatio: "9:16",
          audioFile: "voice.mp3",
        });
        expect(result.probe).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
        expect(result.probe.durationSeconds).toBeCloseTo(1, 1);
        expect(NodePath.isAbsolute(result.file)).toBe(false);
        const target = NodePath.join(workspace, result.file);
        expect(brightness(target, 0.2)).toBeGreaterThan(brightness(target, 0.7) + 0.1);
        expect(brightness(target, 0.9)).toBeGreaterThan(brightness(target, 0.7) + 0.1);
        // Narration is shorter than the cut; audio remains present through the full result.
        const probe = NodeChildProcess.spawnSync("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=duration",
          "-of",
          "csv=p=0",
          target,
        ]);
        expect(Number(probe.stdout.toString().trim())).toBeCloseTo(1, 1);
        expect(NodeFS.readdirSync(NodePath.dirname(target))).toEqual(["render.mp4"]);
        ["clip.mp4", "still.png", "voice.mp3"].forEach((name, i) =>
          expect(NodeFS.readFileSync(NodePath.join(workspace, name))).toEqual(originals[i]),
        );
        expect(s.calls()).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );
  it.effect("accepts 30 scenes while rejecting 31 or more than 60 seconds", () => {
    const s = setup();
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const scenes = Array.from({ length: 30 }, () => ({
        file: "still.png",
        durationSeconds: 0.1,
      }));
      const result = yield* studio.render({ cwd: workspace, scenes, aspectRatio: "1:1" });
      expect(result.probe.durationSeconds).toBeCloseTo(3, 1);
      for (const invalid of [
        [...scenes, scenes[0]!],
        scenes.map((scene) => ({ ...scene, durationSeconds: 2.1 })),
      ]) {
        expect(
          (yield* studio
            .render({ cwd: workspace, scenes: invalid, aspectRatio: "1:1" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_input");
      }
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("mutes source audio by default and retains it only on explicit request", () => {
    const s = setup();
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const base = {
        cwd: workspace,
        scenes: [{ file: "clip.mp4", durationSeconds: 0.5 }],
        aspectRatio: "1:1" as const,
      };
      const muted = yield* studio.render(base);
      expect(muted.probe.hasAudio).toBe(false);
      const retained = yield* studio.render({
        ...base,
        keepSourceAudio: true,
        audioFile: "voice.mp3",
      });
      expect(retained.probe.hasAudio).toBe(true);
      const samples = ffmpeg([
        "-i",
        NodePath.join(workspace, retained.file),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "s16le",
        "-",
      ]);
      let energy = 0;
      for (let i = 0; i + 1 < samples.length; i += 2) energy += samples.readInt16LE(i) ** 2;
      expect(Math.sqrt(energy / (samples.length / 2))).toBeGreaterThan(100);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("refuses playlists disguised as audio and removes the failed render", () => {
    const s = setup();
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      NodeFS.writeFileSync(
        NodePath.join(workspace, "playlist.mp3"),
        "ffconcat version 1.0\nfile '/etc/hosts'\n",
      );
      const before = NodeFS.readdirSync(workspace);
      const error = yield* studio
        .render({
          cwd: workspace,
          scenes: [{ file: "still.png", durationSeconds: 0.2 }],
          aspectRatio: "1:1",
          audioFile: "playlist.mp3",
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("render");
      expect(NodeFS.readdirSync(workspace)).toEqual(before);
      NodeFS.unlinkSync(NodePath.join(workspace, "playlist.mp3"));
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("supports padded square and landscape silent output, and never overwrites", () => {
    const s = setup();
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const files: string[] = [];
      for (const aspectRatio of ["1:1", "16:9", "1:1"] as const) {
        const result = yield* studio.render({
          cwd: workspace,
          scenes: [{ file: "still.png", durationSeconds: 0.2 }],
          aspectRatio,
          fit: "pad",
        });
        expect(result.probe).toMatchObject({
          width: aspectRatio === "1:1" ? 1080 : 1920,
          height: 1080,
          hasAudio: false,
        });
        files.push(result.file);
      }
      expect(new Set(files).size).toBe(3);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect(
    "rejects invalid ranges, traversal and audio symlink escapes without leaving output",
    () => {
      const s = setup();
      return Effect.gen(function* () {
        const studio = yield* StudioMedia.StudioMedia;
        const before = NodeFS.readdirSync(workspace);
        for (const scenes of [
          [],
          [{ file: "clip.mp4", durationSeconds: 2 }],
          [{ file: "../clip.mp4", durationSeconds: 1 }],
          [{ file: "clip.mp4", durationSeconds: NaN }],
          [{ file: "clip.mp4", durationSeconds: 1, onScreenText: "x".repeat(201) }],
          [{ file: "clip.mp4", durationSeconds: 1, captions: [{ start: 0, end: 2, text: "bad" }] }],
        ]) {
          yield* studio.render({ cwd: workspace, scenes, aspectRatio: "1:1" }).pipe(Effect.flip);
        }
        NodeFS.symlinkSync("/etc/hosts", NodePath.join(workspace, "escape.mp3"));
        yield* studio
          .render({
            cwd: workspace,
            scenes: [{ file: "still.png", durationSeconds: 1 }],
            aspectRatio: "1:1",
            audioFile: "escape.mp3",
          })
          .pipe(Effect.flip);
        NodeFS.unlinkSync(NodePath.join(workspace, "escape.mp3"));
        expect(NodeFS.readdirSync(workspace)).toEqual(before);
        expect(s.calls()).toBe(0);
      }).pipe(Effect.provide(s.layer));
    },
  );
  it.effect(
    "only explicitly invoked narration calls the saved-audio endpoint and writes a new playable file",
    () => {
      const s = setup();
      return Effect.gen(function* () {
        const studio = yield* StudioMedia.StudioMedia;
        expect(s.calls()).toBe(0);
        const result = yield* studio.narration({ cwd: workspace, text: "Hello" });
        expect(s.calls()).toBe(1);
        expect(result.file).toMatch(/^studio-.*\/narration.mp3$/);
        expect(NodeFS.readFileSync(NodePath.join(workspace, result.file))).toEqual(originals[2]);
      }).pipe(Effect.provide(s.layer));
    },
  );
  it.effect("preflights valid narration without HTTP, output files or exposed credentials", () => {
    const s = setup();
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const before = NodeFS.readdirSync(workspace);
      expect(yield* studio.checkNarration({ cwd: workspace, text: "Hello" })).toBeUndefined();
      expect(
        yield* studio.checkNarration({ cwd: workspace, text: "Hello", voiceId: "custom_voice-1" }),
      ).toBeUndefined();
      expect(NodeFS.readdirSync(workspace)).toEqual(before);
      expect(s.calls()).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("preflight rejects missing credentials and invalid inputs with zero HTTP", () => {
    const s = setup(200, false);
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const before = NodeFS.readdirSync(workspace);
      for (const input of [
        { text: " " },
        { text: "x".repeat(5001) },
        { text: "Hello", voiceId: "../voice" },
        { text: "Hello", voiceId: "" },
      ]) {
        expect(
          (yield* studio.checkNarration({ cwd: workspace, ...input }).pipe(Effect.flip)).reason,
        ).toBe("invalid_input");
      }
      expect(
        (yield* studio.checkNarration({ cwd: workspace, text: "Hello" }).pipe(Effect.flip)).reason,
      ).toBe("not_configured");
      expect(
        (yield* studio
          .checkNarration({ cwd: NodePath.join(workspace, "missing"), text: "Hello" })
          .pipe(Effect.flip)).reason,
      ).toBe("storage");
      expect(NodeFS.readdirSync(workspace)).toEqual(before);
      expect(s.calls()).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("does not bill invalid input or missing credentials", () => {
    const s = setup(200, false);
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      expect(
        (yield* studio.narration({ cwd: workspace, text: " " }).pipe(Effect.flip)).reason,
      ).toBe("invalid_input");
      expect(
        (yield* studio.narration({ cwd: workspace, text: "Hello" }).pipe(Effect.flip)).reason,
      ).toBe("not_configured");
      expect(s.calls()).toBe(0);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect(
    "does not retry provider failure, leaks no response text and removes incomplete output",
    () => {
      const s = setup(429);
      return Effect.gen(function* () {
        const studio = yield* StudioMedia.StudioMedia;
        const before = NodeFS.readdirSync(workspace);
        const error = yield* studio.narration({ cwd: workspace, text: "Hello" }).pipe(Effect.flip);
        expect(error.reason).toBe("provider");
        expect(error.message).not.toContain("private");
        expect(s.calls()).toBe(1);
        expect(NodeFS.readdirSync(workspace)).toEqual(before);
      }).pipe(Effect.provide(s.layer));
    },
  );
  it.effect("times out an ambiguous request without retrying or leaving output", () => {
    const s = setup(200, true, "hang");
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const before = NodeFS.readdirSync(workspace);
      const fiber = yield* studio
        .narration({ cwd: workspace, text: "Hello" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(s.requested);
      yield* TestClock.adjust("91 seconds");
      expect((yield* Fiber.join(fiber)).reason).toBe("provider");
      expect(s.calls()).toBe(1);
      expect(NodeFS.readdirSync(workspace)).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  });
  it.effect("discards successful HTTP responses that are not playable audio", () => {
    const s = setup(200, true, "invalid");
    return Effect.gen(function* () {
      const studio = yield* StudioMedia.StudioMedia;
      const before = NodeFS.readdirSync(workspace);
      expect(
        (yield* studio.narration({ cwd: workspace, text: "Hello" }).pipe(Effect.flip)).reason,
      ).toBe("provider");
      expect(s.calls()).toBe(1);
      expect(NodeFS.readdirSync(workspace)).toEqual(before);
    }).pipe(Effect.provide(s.layer));
  });
});
