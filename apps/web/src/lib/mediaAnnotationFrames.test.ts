import { ComposerContextId, type MediaAnnotationContextRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { prepareMediaAnnotationFrames, type FetchedFrame } from "./mediaAnnotationFrames.ts";

const note = (
  id: string,
  overrides: Partial<MediaAnnotationContextRecord> = {},
): MediaAnnotationContextRecord => ({
  version: 1,
  kind: "media-annotation",
  contextId: ComposerContextId.make(`media-annotation_${id}`),
  label: id,
  annotationId: id,
  filePath: "reel.mp4",
  mediaKind: "video",
  comment: id,
  ...overrides,
});

const frameAt = (at: number): FetchedFrame => ({ at, base64: "QUJD", mimeType: "image/jpeg" });

describe("prepareMediaAnnotationFrames", () => {
  it("asks for start, middle and end of a range and binds the frames to the note", async () => {
    const asked: Array<ReadonlyArray<number>> = [];
    const result = await prepareMediaAnnotationFrames({
      records: [note("a", { timeStart: 2, timeEnd: 6 })],
      fetchFrames: async (_record, times) => {
        asked.push(times);
        return times.map(frameAt);
      },
    });
    expect(asked).toEqual([[2, 4, 6]]);
    expect(result.frames.map((frame) => frame.name)).toEqual([
      "media-frame-a-1.jpg",
      "media-frame-a-2.jpg",
      "media-frame-a-3.jpg",
    ]);
    expect(result.records[0]).toMatchObject({
      frameTimes: [2, 4, 6],
      frameContextIds: ["image_media-frame-a-1", "image_media-frame-a-2", "image_media-frame-a-3"],
    });
    expect(result.notice).toBeNull();
  });

  it("uses one frame for a moment and for an image", async () => {
    const result = await prepareMediaAnnotationFrames({
      records: [note("m", { timeStart: 5 }), note("i", { mediaKind: "image", filePath: "a.png" })],
      fetchFrames: async (_record, times) => times.map(frameAt),
    });
    expect(result.frames).toHaveLength(2);
  });

  it("trims to the message cap and says so, still sending every note", async () => {
    const records = ["a", "b", "c", "d", "e"].map((id) => note(id, { timeStart: 1, timeEnd: 9 }));
    const result = await prepareMediaAnnotationFrames({
      records,
      fetchFrames: async (_record, times) => times.map(frameAt),
    });
    expect(result.frames.length).toBeLessThanOrEqual(12);
    expect(result.records).toHaveLength(5);
    expect(result.notice).toContain("limit is 12 per message");
    // Everyone keeps at least their start and end before anyone keeps a middle.
    expect(result.records.every((record) => (record.frameTimes?.length ?? 0) >= 2)).toBe(true);
  });

  it("marks notes beyond the budget as sent without frames", async () => {
    const records = ["a", "b", "c"].map((id) => note(id, { timeStart: 1 }));
    const result = await prepareMediaAnnotationFrames({
      records,
      maxFrames: 2,
      fetchFrames: async (_record, times) => times.map(frameAt),
    });
    expect(result.records[2]?.frameContextIds).toBeUndefined();
    expect(result.records[2]?.framesNote).toContain("most frames");
  });

  it("sends the note with the reason when the server cannot make frames", async () => {
    const result = await prepareMediaAnnotationFrames({
      records: [note("a", { timeStart: 1 }), note("b", { timeStart: 2 })],
      fetchFrames: async (record, times) => {
        if (record.annotationId === "a") throw new Error("ffmpeg is not installed");
        return times.map(frameAt);
      },
    });
    expect(result.records[0]).toMatchObject({ framesNote: "ffmpeg is not installed" });
    expect(result.records[0]?.frameContextIds).toBeUndefined();
    expect(result.records[1]?.frameContextIds).toHaveLength(1);
    expect(result.notice).toContain("ffmpeg is not installed");
  });

  it("drops frames left over from an earlier attempt", async () => {
    const result = await prepareMediaAnnotationFrames({
      records: [
        note("a", {
          timeStart: 1,
          frameContextIds: [ComposerContextId.make("image_old")],
          framesNote: "old",
        }),
      ],
      fetchFrames: async (_record, times) => times.map(frameAt),
    });
    expect(result.records[0]?.framesNote).toBeUndefined();
    expect(result.records[0]?.frameContextIds).toEqual(["image_media-frame-a-1"]);
  });
});
