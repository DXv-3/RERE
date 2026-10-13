// @effect-diagnostics nodeBuiltinImport:off - The export writes real files, so the test reads them back from a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Campaign, CampaignClient, CampaignPost } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, describe, expect } from "vite-plus/test";

import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { exportFolderFor, exportSlug, makeExportConnector } from "./ExportConnector.ts";

const AT = "2026-10-06T12:00:00.000Z";
const client: CampaignClient = {
  id: "client-1",
  name: "Candid Studios",
  brandNotes: "",
  doNotSay: [],
  approvalMode: "ask-first",
  createdAt: AT,
  updatedAt: AT,
};
const campaign: Campaign = {
  id: "campaign-1",
  clientId: "client-1",
  name: "October Reels!",
  createdAt: AT,
  updatedAt: AT,
};
const post = (overrides: Partial<CampaignPost> = {}): CampaignPost => ({
  id: "post_abc",
  campaignId: "campaign-1",
  status: "publishing",
  platforms: ["instagram", "facebook"],
  captions: { default: "Default words", byPlatform: { instagram: "Instagram words" } },
  mediaPaths: ["media/clip.mp4"],
  mediaUrls: [],
  uploadedMedia: {},
  createdBy: { kind: "person" },
  approval: { by: "person", at: AT },
  publishResults: {},
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const decodeSummary = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      client: Schema.String,
      mediaFiles: Schema.Array(Schema.String),
      captions: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);

const TestLayer = WorkspacePaths.layer.pipe(Layer.provideMerge(NodeServices.layer));

let workspace = "";
let outside = "";

beforeAll(() => {
  workspace = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-export-ws-")),
  );
  outside = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-export-out-")),
  );
  NodeFS.mkdirSync(NodePath.join(workspace, "media"));
  NodeFS.writeFileSync(NodePath.join(workspace, "media", "clip.mp4"), "video-bytes");
  NodeFS.writeFileSync(NodePath.join(outside, "secret.mp4"), "secret");
  NodeFS.symlinkSync(
    NodePath.join(outside, "secret.mp4"),
    NodePath.join(workspace, "media", "link.mp4"),
  );
});
afterAll(() => {
  NodeFS.rmSync(workspace, { recursive: true, force: true });
  NodeFS.rmSync(outside, { recursive: true, force: true });
});

describe("exportSlug", () => {
  it("makes a safe folder name", () => {
    expect(exportSlug("Candid Studios")).toBe("candid-studios");
    expect(exportSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(exportSlug("!!!")).toBe("untitled");
    expect(exportFolderFor({ clientName: "A B", campaignName: "C", postId: "post_1" })).toBe(
      "campaigns/a-b/c/export/post-1",
    );
  });
});

it.layer(TestLayer)("ExportConnector", (it) => {
  const connector = (folder: string | null) =>
    makeExportConnector({ folderFor: () => Effect.succeed(folder) });

  it.effect("copies the media and writes a caption per platform and post.json", () =>
    Effect.gen(function* () {
      const exporter = yield* connector(workspace);
      const first = yield* exporter.publish({
        post: post(),
        platform: "instagram",
        client,
        campaign,
      });
      assert.isTrue(first.success);
      const folder = NodePath.join(
        workspace,
        "campaigns/candid-studios/october-reels/export/post-abc",
      );
      assert.strictEqual(first.link, folder);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(folder, "01-clip.mp4"), "utf8"),
        "video-bytes",
      );
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(folder, "caption-instagram.txt"), "utf8"),
        "Instagram words\n",
      );

      // A second platform adds its own caption to the same folder.
      yield* exporter.publish({ post: post(), platform: "facebook", client, campaign });
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(folder, "caption-facebook.txt"), "utf8"),
        "Default words\n",
      );
      const summary = decodeSummary(
        NodeFS.readFileSync(NodePath.join(folder, "post.json"), "utf8"),
      );
      assert.strictEqual(summary.client, "Candid Studios");
      assert.deepStrictEqual(summary.mediaFiles, ["01-clip.mp4"]);
      assert.deepStrictEqual(summary.captions, {
        instagram: "Instagram words",
        facebook: "Default words",
      });
    }),
  );

  it.effect("refuses media outside the folder, including through a symlink", () =>
    Effect.gen(function* () {
      const exporter = yield* connector(workspace);
      for (const mediaPath of [
        "../escape.mp4",
        "/etc/passwd",
        "media/link.mp4",
        "media/missing.mp4",
      ]) {
        const outcome = yield* exporter.publish({
          post: post({ mediaPaths: [mediaPath] }),
          platform: "instagram",
          client,
          campaign,
        });
        assert.isFalse(outcome.success, mediaPath);
        assert.include(outcome.error ?? "", "inside the project folder");
      }
    }),
  );

  it.effect("says so when the post has no folder or the folder is gone", () =>
    Effect.gen(function* () {
      const none = yield* (yield* connector(null)).publish({
        post: post(),
        platform: "instagram",
        client,
        campaign,
      });
      assert.include(none.error ?? "", "no project folder");
      const gone = yield* (yield* connector(NodePath.join(workspace, "nope"))).publish({
        post: post(),
        platform: "instagram",
        client,
        campaign,
      });
      assert.include(gone.error ?? "", "not available");
    }),
  );

  it.effect("reports itself as always open", () =>
    Effect.gen(function* () {
      const exporter = yield* connector(workspace);
      assert.deepStrictEqual(yield* exporter.autopostState("x"), {
        kind: "known",
        paused: false,
        masterEnabled: true,
      });
      assert.deepStrictEqual(yield* exporter.test(), { ok: true });
    }),
  );
});
