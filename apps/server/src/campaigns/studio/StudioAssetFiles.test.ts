// @effect-diagnostics nodeBuiltinImport:off - isolated local file fixtures only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as StudioAssetFiles from "./StudioAssetFiles.ts";

let fixture = "";
let source = "";
let destination = "";
const bytes = new Uint8Array([0, 255, 12, 99, 42]);
const uploadId = "pending-11111111-2222-3333-4444-555555555555-mp4";
beforeEach(() => {
  fixture = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-assets-test-"));
  source = NodePath.join(fixture, "source");
  destination = NodePath.join(fixture, "destination");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(destination);
});
afterEach(() => NodeFS.rmSync(fixture, { recursive: true, force: true }));
function layer() {
  return StudioAssetFiles.layer.pipe(
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(ServerConfig.layerTest(fixture, { prefix: "studio-assets-config-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("StudioAssetFiles owned copies", () => {
  it.effect("copies a pending upload byte-for-byte without claiming or removing the original", () =>
    Effect.gen(function* () {
      const files = yield* StudioAssetFiles.StudioAssetFiles;
      const config = yield* ServerConfig.ServerConfig;
      const original = NodePath.join(config.attachmentsDir, `${uploadId}.mp4`);
      NodeFS.writeFileSync(original, bytes);
      const copied = yield* files.copy({
        cwd: destination,
        kind: "video",
        source: { attachmentId: uploadId },
      });
      expect(copied.file).toMatch(/^studio-import-[^/\\]+[/\\]asset\.mp4$/);
      expect(NodePath.isAbsolute(copied.file)).toBe(false);
      expect(new Uint8Array(NodeFS.readFileSync(NodePath.join(destination, copied.file)))).toEqual(
        bytes,
      );
      expect(new Uint8Array(NodeFS.readFileSync(original))).toEqual(bytes);
      expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([`${uploadId}.mp4`]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "copies a source from a different workspace and discard removes only that owned copy",
    () =>
      Effect.gen(function* () {
        const files = yield* StudioAssetFiles.StudioAssetFiles;
        const original = NodePath.join(source, "original.mp4");
        NodeFS.writeFileSync(original, bytes);
        NodeFS.writeFileSync(NodePath.join(destination, "keep.txt"), "keep");
        const first = yield* files.copy({
          cwd: destination,
          kind: "video",
          source: { cwd: source, file: "original.mp4" },
        });
        const second = yield* files.copy({
          cwd: destination,
          kind: "video",
          source: { cwd: source, file: "original.mp4" },
        });
        expect(first.file).not.toBe(second.file);
        expect(new Uint8Array(NodeFS.readFileSync(NodePath.join(destination, first.file)))).toEqual(
          bytes,
        );
        yield* first.discard;
        yield* first.discard;
        expect(NodeFS.existsSync(NodePath.join(destination, first.file))).toBe(false);
        expect(new Uint8Array(NodeFS.readFileSync(original))).toEqual(bytes);
        expect(
          new Uint8Array(NodeFS.readFileSync(NodePath.join(destination, second.file))),
        ).toEqual(bytes);
        expect(NodeFS.readFileSync(NodePath.join(destination, "keep.txt"), "utf8")).toBe("keep");
      }).pipe(Effect.provide(layer())),
  );

  it.effect.each([
    "../outside.mp4",
    "..\\outside.mp4",
    "absolute",
    "symlink.mp4",
    "nested/escape.mp4",
  ])("rejects an escaping source: %s", (name) =>
    Effect.gen(function* () {
      const files = yield* StudioAssetFiles.StudioAssetFiles;
      const outside = NodePath.join(fixture, "outside.mp4");
      NodeFS.writeFileSync(outside, bytes);
      if (name === "symlink.mp4") NodeFS.symlinkSync(outside, NodePath.join(source, name));
      if (name === "nested/escape.mp4") {
        NodeFS.mkdirSync(NodePath.join(source, "nested"));
        NodeFS.symlinkSync(outside, NodePath.join(source, name));
      }
      const error = yield* files
        .copy({
          cwd: destination,
          kind: "video",
          source: { cwd: source, file: name === "absolute" ? outside : name },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("CampaignError");
      expect(NodeFS.readdirSync(destination)).toEqual([]);
      expect(new Uint8Array(NodeFS.readFileSync(outside))).toEqual(bytes);
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects a pending-upload symlink outside attachment storage", () =>
    Effect.gen(function* () {
      const files = yield* StudioAssetFiles.StudioAssetFiles;
      const config = yield* ServerConfig.ServerConfig;
      const outside = NodePath.join(fixture, "outside.mp4");
      NodeFS.writeFileSync(outside, bytes);
      NodeFS.symlinkSync(outside, NodePath.join(config.attachmentsDir, `${uploadId}.mp4`));
      const error = yield* files
        .copy({ cwd: destination, kind: "video", source: { attachmentId: uploadId } })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid");
      expect(NodeFS.readdirSync(destination)).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each([
    "thread-11111111-2222-3333-4444-555555555555-mp4",
    "pending-other-11111111-2222-3333-4444-555555555555-mp4",
    "pending-invalid",
    "pending-../outside",
  ])("requires the exact pending upload namespace: %s", (attachmentId) =>
    Effect.gen(function* () {
      const files = yield* StudioAssetFiles.StudioAssetFiles;
      const config = yield* ServerConfig.ServerConfig;
      if (!attachmentId.includes("/"))
        NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${attachmentId}.mp4`), bytes);
      const error = yield* files
        .copy({ cwd: destination, kind: "video", source: { attachmentId } })
        .pipe(Effect.flip);
      expect(error.reason).toBe("invalid");
      expect(NodeFS.readdirSync(destination)).toEqual([]);
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each(["extension", "empty", "oversize", "directory"] as const)(
    "rejects %s media before creating a copy",
    (invalid) =>
      Effect.gen(function* () {
        const files = yield* StudioAssetFiles.StudioAssetFiles;
        const name = invalid === "extension" ? "file.mp3" : "file.mp4";
        const original = NodePath.join(source, name);
        if (invalid === "directory") NodeFS.mkdirSync(original);
        else {
          NodeFS.writeFileSync(original, invalid === "empty" ? new Uint8Array() : bytes);
          if (invalid === "oversize") NodeFS.truncateSync(original, 100 * 1024 * 1024 + 1);
        }
        const error = yield* files
          .copy({ cwd: destination, kind: "video", source: { cwd: source, file: name } })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid");
        expect(NodeFS.readdirSync(destination)).toEqual([]);
        expect(NodeFS.existsSync(original)).toBe(true);
      }).pipe(Effect.provide(layer())),
  );
});
