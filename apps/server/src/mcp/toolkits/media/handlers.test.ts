// @effect-diagnostics nodeBuiltinImport:off - ffmpeg makes the clip the tool inspects.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { serializeMediaAnnotationsSidecar } from "@t3tools/shared/mediaAnnotations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import * as MediaService from "../../../media/MediaService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as WorkspaceEntries from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { chooseInspectTimes, inspectMedia, mediaInspectOutput } from "./handlers.ts";

const ffmpegAvailable = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

describe("chooseInspectTimes", () => {
  const video = { kind: "video" as const, durationSeconds: 8, fps: 25 };

  it("spreads a handful of frames through the clip by default", () => {
    expect(chooseInspectTimes({ at: undefined, count: undefined, probe: video })).toEqual([
      1, 3, 5, 7,
    ]);
  });

  it("honours the moments asked for, and caps a large count", () => {
    expect(chooseInspectTimes({ at: [2, 6.5], count: 5, probe: video })).toEqual([2, 6.5]);
    expect(chooseInspectTimes({ at: undefined, count: 99, probe: video })).toHaveLength(8);
  });

  it("looks at an image once", () => {
    expect(
      chooseInspectTimes({
        at: [3],
        count: 4,
        probe: { kind: "image", durationSeconds: null, fps: null },
      }),
    ).toEqual([0]);
  });
});

describe("mediaInspectOutput", () => {
  it("sends frames as images and leaves their bytes out of the JSON", () => {
    const output = mediaInspectOutput({
      file: "a.mp4",
      probe: {
        kind: "video",
        durationSeconds: 1,
        width: 2,
        height: 2,
        fps: 10,
        hasAudio: false,
        codec: "h264",
        sizeBytes: 1,
      },
      frames: [{ at: 0.5, mimeType: "image/jpeg", base64: "QUJD", width: 2, height: 2 }],
      openAnnotations: [],
      notes: [],
    });
    expect(output.images).toEqual([{ data: "QUJD", mimeType: "image/jpeg" }]);
    expect(JSON.stringify(output.metadata)).not.toContain("QUJD");
    expect(output.metadata).toMatchObject({ frames: [{ at: 0.5, width: 2, height: 2 }] });
  });
});

const TestLayer = Layer.mergeAll(
  MediaService.layer,
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  ),
).pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-media-inspect-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

let workspace = "";

beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-inspect-")),
  );
  if (!ffmpegAvailable) return;
  const result = NodeChildProcess.spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=4:size=160x90:rate=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    NodePath.join(workspace, "reel.mp4"),
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  NodeFS.writeFileSync(
    NodePath.join(workspace, "reel.mp4.annotations.json"),
    serializeMediaAnnotationsSidecar([
      { id: "late", status: "open", comment: "cut here", createdAt: "t", timeStart: 3 },
      {
        id: "early",
        status: "open",
        comment: "logo too small",
        createdAt: "t",
        timeStart: 1,
        timeEnd: 2,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      },
      { id: "done", status: "resolved", comment: "fixed", createdAt: "t", timeStart: 0.5 },
    ]),
  );
});

afterAll(() => NodeFS.rmSync(workspace, { recursive: true, force: true }));

describe.skipIf(!ffmpegAvailable)("inspectMedia", () => {
  it.layer(TestLayer, { excludeTestServices: true })("with ffmpeg", (it) => {
    it.effect("returns facts, frames and only the open notes, in time order", () =>
      Effect.gen(function* () {
        const result = yield* inspectMedia(workspace, { file: "reel.mp4", count: 3 });
        expect(result.probe).toMatchObject({ kind: "video", width: 160, height: 90 });
        expect(result.frames).toHaveLength(3);
        expect(result.openAnnotations.map((note) => note.id)).toEqual(["early", "late"]);
        expect(result.openAnnotations[0]).toMatchObject({
          comment: "logo too small",
          timeStart: 1,
          timeEnd: 2,
        });
        expect(result.notes).toEqual([]);
      }),
    );

    it.effect("looks at the moments it is asked for", () =>
      Effect.gen(function* () {
        const result = yield* inspectMedia(workspace, { file: "reel.mp4", at: [0.5, 2.5] });
        expect(result.frames.map((frame) => frame.at)).toEqual([0.5, 2.5]);
      }),
    );

    it.effect("refuses a path outside the folder with a reason the model can read", () =>
      Effect.gen(function* () {
        const error = yield* inspectMedia(workspace, { file: "../secret.mp4" }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MediaError", reason: "outside_workspace" });
      }),
    );
  });
});
