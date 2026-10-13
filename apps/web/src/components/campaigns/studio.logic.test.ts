import {
  ThreadId,
  type CampaignPost,
  type StudioAsset,
  type StudioBrief,
  type StudioScene,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  duplicateStudioScene,
  moveStudioScene,
  studioAssets,
  studioAssistantPrompt,
  studioCalendarPosts,
  studioDraftProblems,
  storyboardTemplateScenes,
  STORYBOARD_TEMPLATES,
  studioSceneVariants,
  studioUploadKind,
} from "./studio.logic";

const scene: StudioScene = {
  id: "one",
  title: "Hook",
  durationSeconds: 5,
  prompt: "Product reveal",
  referenceImage: null,
  narration: "Meet it",
  onScreenText: "New",
  selectedAssetId: "asset",
  connector: "fal",
  model: "model",
  resolution: "720p",
  generateAudio: false,
  allowanceUsd: 1,
};
const brief: StudioBrief = {
  offer: "Offer",
  audience: "Makers",
  objective: "Launch",
  platforms: ["instagram"],
  references: [],
  durationSeconds: 15,
  sourceThreadId: ThreadId.make("thread"),
};

describe("Studio storyboard edits", () => {
  it("reorders without mutating and preserves scene identities", () => {
    const scenes = [scene, { ...scene, id: "two" }, { ...scene, id: "three" }];
    expect(moveStudioScene(scenes, "two", -1).map((value) => value.id)).toEqual([
      "two",
      "one",
      "three",
    ]);
    expect(moveStudioScene(scenes, "two", 1).map((value) => value.id)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(scenes.map((value) => value.id)).toEqual(["one", "two", "three"]);
    expect(moveStudioScene(scenes, "one", -1)).toBe(scenes);
    expect(moveStudioScene(scenes, "missing", 1)).toBe(scenes);
  });
  it("duplicates the creative inputs but requires an explicit variant choice", () => {
    const result = duplicateStudioScene([scene], "one", "copy");
    expect(result[1]).toMatchObject({
      id: "copy",
      title: "Hook copy",
      prompt: scene.prompt,
      narration: scene.narration,
      selectedAssetId: null,
    });
    expect(result[0]).toBe(scene);
  });
  it("rejects invalid durations, trim starts, caption windows and spend limits", () => {
    expect(studioDraftProblems(brief, [scene])).toEqual([]);
    expect(studioDraftProblems({ ...brief, durationSeconds: 14 }, [scene])).toHaveLength(1);
    expect(studioDraftProblems(brief, [{ ...scene, durationSeconds: NaN }])).toHaveLength(1);
    expect(
      studioDraftProblems(brief, [
        {
          ...scene,
          startSeconds: -1,
          allowanceUsd: -1,
          captions: [{ start: 3, end: 7, text: "Late" }],
        },
      ]),
    ).toHaveLength(3);
    expect(
      studioDraftProblems(brief, [
        { ...scene, durationSeconds: 30 },
        { ...scene, durationSeconds: 30 },
        scene,
      ]),
    ).toContain("The storyboard must be at most 60 seconds.");
  });
});

describe("Studio library and calendar", () => {
  it("searches generation provenance and combines it with media kind", () => {
    const asset: StudioAsset = {
      id: "asset",
      sceneId: null,
      kind: "video",
      file: "clips/one.mp4",
      sourceThreadId: ThreadId.make("thread"),
      jobId: "job",
      prompt: "A green bicycle",
      model: "veo",
      connector: "fal",
      createdAt: "2026-10-08T12:00:00Z",
      approved: false,
    };
    expect(studioAssets([asset], " BICYCLE ", "all")).toEqual([asset]);
    expect(studioAssets([asset], "fal", "image")).toEqual([]);
  });
  it("filters by local calendar month and platform and orders scheduled posts", () => {
    const base: CampaignPost = {
      id: "one",
      campaignId: "campaign",
      status: "draft",
      platforms: ["instagram"],
      captions: { default: "Caption", byPlatform: {} },
      mediaPaths: [],
      mediaUrls: [],
      uploadedMedia: {},
      publishResults: {},
      createdBy: { kind: "person" },
      approval: null,
      createdAt: "2026-10-08T12:00:00Z",
      updatedAt: "2026-10-08T12:00:00Z",
    };
    const early = { ...base, scheduledAt: new Date(2026, 9, 8, 12).toISOString() };
    const late = { ...early, id: "two", scheduledAt: new Date(2026, 9, 9, 12).toISOString() };
    const otherMonth = {
      ...early,
      id: "three",
      scheduledAt: new Date(2026, 10, 8, 12).toISOString(),
    };
    expect(
      studioCalendarPosts([late, base, otherMonth, early], "2026-10", "instagram").map(
        (value) => value.id,
      ),
    ).toEqual(["one", "two"]);
    expect(studioCalendarPosts([early], "2026-10", "youtube")).toEqual([]);
  });
});

it("gives the real composer exact campaign context and leaves paid work for approval", () => {
  const prompt = studioAssistantPrompt("campaign-id", "Autumn launch", brief, true);
  expect(prompt).toContain('campaignId: "campaign-id"');
  expect(prompt).toContain("campaign_studio_read");
  expect(prompt).toContain("campaign_studio_edit");
  expect(prompt).toContain("Help me revise");
  expect(prompt).toContain("wait for my explicit spend approval");
});

describe("Local storyboard templates", () => {
  it.each(STORYBOARD_TEMPLATES)(
    "builds editable $label scenes from saved context without authorizing generation",
    ({ id }) => {
      let serial = 0;
      const original = { ...brief, durationSeconds: 31, references: ["assets/product.png"] };
      const result = storyboardTemplateScenes(
        id,
        original,
        "Calm, practical tone",
        () => `new-${serial++}`,
      );
      expect(result.reduce((sum, value) => sum + value.durationSeconds, 0)).toBe(31);
      expect(studioDraftProblems(original, result)).toEqual([]);
      expect(new Set(result.map((value) => value.id)).size).toBe(result.length);
      for (const value of result) {
        expect(value.prompt).toContain("Offer");
        expect(value.prompt).toContain("Makers");
        expect(value.prompt).toContain("Launch");
        expect(value.prompt).toContain("Calm, practical tone");
        expect(value.prompt).toContain("assets/product.png");
        expect(value).toMatchObject({
          selectedAssetId: null,
          connector: "",
          model: "",
          allowanceUsd: null,
          generateAudio: false,
        });
      }
      expect(original).toEqual({
        ...brief,
        durationSeconds: 31,
        references: ["assets/product.png"],
      });
    },
  );
  it("leaves customer quotes for verification instead of fabricating an endorsement", () => {
    const result = storyboardTemplateScenes("testimonial", brief, "", () => "id");
    expect(result[2]?.narration).toBe("[Insert an approved, verbatim customer quote.]");
  });
});

it("compares only visual assets belonging to this scene or shared in the campaign", () => {
  const asset: StudioAsset = {
    id: "one",
    sceneId: "one",
    kind: "video",
    file: "one.mp4",
    sourceThreadId: ThreadId.make("source"),
    jobId: null,
    prompt: "",
    model: "",
    connector: "",
    createdAt: "2026-10-08T12:00:00Z",
    approved: false,
  };
  const shared = { ...asset, id: "shared", sceneId: null, kind: "image" as const };
  expect(
    studioSceneVariants(
      [
        asset,
        shared,
        { ...asset, id: "other", sceneId: "two" },
        { ...asset, id: "audio", kind: "audio" },
      ],
      "one",
    ),
  ).toEqual([asset, shared]);
});

it("accepts supported media extensions without trusting an arbitrary MIME or path", () => {
  expect(studioUploadKind({ name: "SPEECH.MP3", type: "" })).toBe("audio");
  expect(studioUploadKind({ name: "product.jpg", type: "application/octet-stream" })).toBe("image");
  expect(studioUploadKind({ name: "clip.mov", type: "video/quicktime" })).toBe("video");
  expect(studioUploadKind({ name: "script.exe", type: "image/png" })).toBeNull();
  expect(studioUploadKind({ name: "README", type: "" })).toBeNull();
});
