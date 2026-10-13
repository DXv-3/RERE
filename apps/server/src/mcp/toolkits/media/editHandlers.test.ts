// @effect-diagnostics nodeBuiltinImport:off - ffmpeg makes the clip the tool edits.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import * as MediaEdit from "../../../media/MediaEdit.ts";
import * as MediaService from "../../../media/MediaService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { editMedia } from "./editHandlers.ts";
import { MediaEditTool } from "./editTools.ts";

const ffmpegAvailable = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

const TestLayer = MediaEdit.layer.pipe(
  Layer.provideMerge(MediaService.layer),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-media-edit-tool-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

let workspace = "";

beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-edit-tool-")),
  );
  if (!ffmpegAvailable) return;
  NodeChildProcess.spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=160x90:rate=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    NodePath.join(workspace, "clip.mp4"),
  ]);
});

afterAll(() => NodeFS.rmSync(workspace, { recursive: true, force: true }));

describe("media_edit tool", () => {
  it("tells the agent to work on a copy, say which file, and inspect it", () => {
    expect(MediaEditTool.description).toContain("always work on a copy");
    expect(MediaEditTool.description).toContain("tell the person which file you made");
    expect(MediaEditTool.description).toContain("media_inspect");
  });
});

describe.skipIf(!ffmpegAvailable)("editMedia", () => {
  it.layer(TestLayer, { excludeTestServices: true })("with ffmpeg", (it) => {
    it.effect("returns the new path, a fresh probe and what to do next", () =>
      Effect.gen(function* () {
        const result = yield* editMedia(workspace, {
          operation: "trim",
          file: "clip.mp4",
          start: 0,
          end: 1,
        });
        expect(result.file).toBe("clip.trim-1.mp4");
        expect(result.probe).toMatchObject({ width: 160, height: 90 });
        expect(result.next).toContain("media_inspect");
      }),
    );

    it.effect("says what a call is missing", () =>
      Effect.gen(function* () {
        const error = yield* editMedia(workspace, { operation: "resize", file: "clip.mp4" }).pipe(
          Effect.flip,
        );
        expect(error.reason).toBe("invalid_request");
        expect(error.message).toContain("shape");
      }),
    );
  });
});
