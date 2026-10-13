import { describe, expect, it } from "@effect/vitest";

import {
  buildFrameFilter,
  clampTimestamp,
  evenlySpacedTimestamps,
  mediaKindFromExtension,
  parseProbeJson,
  scaledFrameSize,
} from "./mediaFfmpeg.ts";

const probeJson = (stream: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...stream }],
    format: { duration: "12.5" },
    ...extra,
  });

describe("parseProbeJson", () => {
  it("reads duration, size, frame rate and codec", () => {
    const probe = parseProbeJson(probeJson({ avg_frame_rate: "30000/1001" }), "video", 99);
    expect(probe).toMatchObject({
      kind: "video",
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      fps: 29.97,
      hasAudio: false,
      codec: "h264",
      sizeBytes: 99,
    });
  });

  it("detects an audio stream", () => {
    const text = JSON.stringify({
      streams: [
        { codec_type: "video", width: 10, height: 10, avg_frame_rate: "24/1" },
        { codec_type: "audio" },
      ],
      format: { duration: "1" },
    });
    expect(parseProbeJson(text, "video", 1)?.hasAudio).toBe(true);
  });

  it("swaps width and height for a clip flagged as rotated a quarter turn", () => {
    const probe = parseProbeJson(
      probeJson({
        side_data_list: [{ rotation: -90 }],
        avg_frame_rate: "0/0",
        r_frame_rate: "25/1",
      }),
      "video",
      1,
    );
    expect(probe).toMatchObject({ width: 1080, height: 1920, fps: 25 });
  });

  it("reports an image without duration or frame rate", () => {
    const probe = parseProbeJson(probeJson({ avg_frame_rate: "25/1" }), "image", 5);
    expect(probe).toMatchObject({ kind: "image", durationSeconds: null, fps: null });
  });

  it("rejects output with no picture stream or invalid JSON", () => {
    expect(
      parseProbeJson(JSON.stringify({ streams: [{ codec_type: "audio" }] }), "video", 1),
    ).toBeNull();
    expect(parseProbeJson("not json", "video", 1)).toBeNull();
  });
});

describe("timestamps", () => {
  it("keeps a request inside the clip and short of its final instant", () => {
    expect(clampTimestamp(-3, 10)).toBe(0);
    expect(clampTimestamp(99, 10)).toBeCloseTo(9.9);
    expect(clampTimestamp(99, 10, 10)).toBeCloseTo(9.8);
    expect(clampTimestamp(5, null)).toBe(0);
  });

  it("spreads frames through the middle of equal slices", () => {
    expect(evenlySpacedTimestamps(4, 8)).toEqual([1, 3, 5, 7]);
    expect(evenlySpacedTimestamps(1, 8)).toEqual([4]);
    expect(evenlySpacedTimestamps(3, null)).toEqual([0]);
  });
});

describe("buildFrameFilter", () => {
  it("only scales when there is no box", () => {
    expect(buildFrameFilter({ maxEdge: 768 })).not.toContain("drawbox");
  });

  it("draws the box in fractions of the scaled frame", () => {
    const filter = buildFrameFilter({
      maxEdge: 768,
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    });
    expect(filter).toContain("x=iw*0.10000:y=ih*0.20000:w=iw*0.30000:h=ih*0.40000");
  });

  it("clips a box that runs past the right or bottom edge", () => {
    const filter = buildFrameFilter({
      maxEdge: 768,
      box: { x: 0.8, y: 0.9, width: 0.5, height: 0.5 },
    });
    expect(filter).toContain("w=iw*0.20000:h=ih*0.10000");
  });
});

describe("helpers", () => {
  it("sizes a frame to the edge without enlarging small sources", () => {
    expect(scaledFrameSize(1920, 1080, 768)).toEqual({ width: 768, height: 432 });
    expect(scaledFrameSize(320, 180, 768)).toEqual({ width: 320, height: 180 });
  });

  it("classifies by extension", () => {
    expect(mediaKindFromExtension(".MP4")).toBe("video");
    expect(mediaKindFromExtension(".webp")).toBe("image");
    expect(mediaKindFromExtension(".svg")).toBeNull();
  });
});
