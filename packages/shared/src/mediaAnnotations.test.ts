import type { MediaAnnotation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allocateAnnotationFrames,
  mediaAnnotationsSidecarPath,
  mergeMediaAnnotations,
  parseMediaAnnotationsSidecar,
  reconcileMediaAnnotationsForWrite,
  planAnnotationFrameTimes,
  serializeMediaAnnotationsSidecar,
  setMediaAnnotationStatus,
  sortMediaAnnotations,
} from "./mediaAnnotations.ts";

const note = (id: string, overrides: Partial<MediaAnnotation> = {}): MediaAnnotation => ({
  id,
  status: "open",
  comment: `note ${id}`,
  createdAt: "2026-10-06T10:00:00.000Z",
  ...overrides,
});

describe("sidecar file", () => {
  it("lives beside the media file", () => {
    expect(mediaAnnotationsSidecarPath("campaigns/a/reel.mp4")).toBe(
      "campaigns/a/reel.mp4.annotations.json",
    );
  });

  it("round-trips through serialize and parse", () => {
    const annotations = [
      note("a", { timeStart: 1.5, timeEnd: 3, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }),
      note("b", { status: "resolved", resolvedAt: "2026-10-06T11:00:00.000Z" }),
    ];
    const text = serializeMediaAnnotationsSidecar(annotations);
    expect(JSON.parse(text).version).toBe(1);
    expect(parseMediaAnnotationsSidecar(text)).toEqual({ status: "ok", annotations, dropped: 0 });
  });

  it("writes an empty review as valid JSON", () => {
    const text = serializeMediaAnnotationsSidecar([]);
    expect(parseMediaAnnotationsSidecar(text)).toEqual({
      status: "ok",
      annotations: [],
      dropped: 0,
    });
  });

  it("drops entries that do not decode and duplicate ids, and keeps the rest", () => {
    const text = JSON.stringify({
      version: 1,
      annotations: [note("a"), { id: "broken" }, note("a", { comment: "again" }), note("c")],
    });
    const parsed = parseMediaAnnotationsSidecar(text);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") {
      expect(parsed.annotations.map((entry) => entry.id)).toEqual(["a", "c"]);
      expect(parsed.dropped).toBe(2);
    }
  });

  it("leaves a newer or unreadable file alone", () => {
    expect(parseMediaAnnotationsSidecar(JSON.stringify({ version: 2, annotations: [] }))).toEqual({
      status: "newer-version",
    });
    expect(parseMediaAnnotationsSidecar("{nope")).toEqual({ status: "invalid" });
    expect(parseMediaAnnotationsSidecar("[]")).toEqual({ status: "invalid" });
    expect(parseMediaAnnotationsSidecar(JSON.stringify({ version: 1 }))).toEqual({
      status: "invalid",
    });
  });
});

describe("merge and status", () => {
  it("prefers the local copy but never reopens a resolved note", () => {
    const resolved = note("a", { status: "resolved", resolvedAt: "2026-10-06T11:00:00.000Z" });
    const merged = mergeMediaAnnotations(
      [resolved, note("b", { comment: "old" })],
      [note("a"), note("b", { comment: "new" }), note("c")],
    );
    expect(merged.find((entry) => entry.id === "a")?.status).toBe("resolved");
    expect(merged.find((entry) => entry.id === "b")?.comment).toBe("new");
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("resolves and reopens, stamping the time only while resolved", () => {
    const resolved = setMediaAnnotationStatus([note("a")], "a", "resolved", "T1");
    expect(resolved[0]).toMatchObject({ status: "resolved", resolvedAt: "T1" });
    const reopened = setMediaAnnotationStatus(resolved, "a", "open", "T2");
    expect(reopened[0]?.status).toBe("open");
    expect(reopened[0]?.resolvedAt).toBeUndefined();
  });

  it("sorts by time with untimed notes last", () => {
    const sorted = sortMediaAnnotations([
      note("late", { timeStart: 9 }),
      note("none"),
      note("early", { timeStart: 1 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["early", "late", "none"]);
  });
});

describe("planAnnotationFrameTimes", () => {
  it("uses one frame for an image or an annotation with no time", () => {
    expect(planAnnotationFrameTimes({ mediaKind: "image" })).toEqual([0]);
    expect(planAnnotationFrameTimes({ mediaKind: "video" })).toEqual([0]);
  });

  it("uses one frame for a moment, including a tiny range", () => {
    expect(planAnnotationFrameTimes({ mediaKind: "video", timeStart: 4 })).toEqual([4]);
    expect(planAnnotationFrameTimes({ mediaKind: "video", timeStart: 4, timeEnd: 4.1 })).toEqual([
      4,
    ]);
  });

  it("uses start, middle and end for a range", () => {
    expect(planAnnotationFrameTimes({ mediaKind: "video", timeStart: 2, timeEnd: 6 })).toEqual([
      2, 4, 6,
    ]);
  });
});

describe("allocateAnnotationFrames", () => {
  it("keeps everything under the cap", () => {
    const result = allocateAnnotationFrames([3, 1, 3], 12);
    expect(result).toEqual({ keep: [[0, 1, 2], [0], [0, 1, 2]], total: 7, trimmed: false });
  });

  it("drops middles before starts and ends when over the cap", () => {
    const result = allocateAnnotationFrames([3, 3, 3], 6);
    expect(result.keep).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
    expect(result.trimmed).toBe(true);
  });

  it("gives later annotations no frames when there are more notes than budget", () => {
    const result = allocateAnnotationFrames([1, 1, 1, 1], 2);
    expect(result.keep).toEqual([[0], [0], [], []]);
    expect(result.total).toBe(2);
    expect(result.trimmed).toBe(true);
  });

  it("never grants more than three frames to one annotation", () => {
    expect(allocateAnnotationFrames([9], 12).keep).toEqual([[0, 1, 2]]);
  });

  it("handles no annotations", () => {
    expect(allocateAnnotationFrames([], 12)).toEqual({ keep: [], total: 0, trimmed: false });
  });
});

describe("reconcileMediaAnnotationsForWrite", () => {
  it("keeps notes someone else added, drops the ones this session removed, and keeps resolutions", () => {
    const resolvedElsewhere = note("a", { status: "resolved", resolvedAt: "T" });
    const result = reconcileMediaAnnotationsForWrite({
      onDisk: [resolvedElsewhere, note("b"), note("theirs")],
      local: [note("a"), note("c")],
      removedIds: new Set(["b"]),
    });
    expect(result.map((entry) => entry.id).sort()).toEqual(["a", "c", "theirs"]);
    expect(result.find((entry) => entry.id === "a")?.status).toBe("resolved");
  });

  it("lets this session reopen a note it deliberately reopened", () => {
    const result = reconcileMediaAnnotationsForWrite({
      onDisk: [note("a", { status: "resolved", resolvedAt: "T" })],
      local: [note("a")],
      removedIds: new Set(),
      statusChangedIds: new Set(["a"]),
    });
    expect(result[0]?.status).toBe("open");
  });

  it("does not bring back a removed note even if the local list still has it", () => {
    const result = reconcileMediaAnnotationsForWrite({
      onDisk: [],
      local: [note("a")],
      removedIds: new Set(["a"]),
    });
    expect(result).toEqual([]);
  });
});
