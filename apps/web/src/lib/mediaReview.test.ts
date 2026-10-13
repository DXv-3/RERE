import { describe, expect, it } from "vite-plus/test";

import {
  boxFromPoints,
  boxToPixels,
  containedContentBox,
  dragBox,
  formatBoxPercent,
  formatTimecode,
  formatTimeRange,
  isAnnotationActiveAt,
  isMeaningfulBox,
  isPointOnContent,
  mediaReviewKindForPath,
  reviewKeyAction,
  nextPlaybackRate,
  normalizeRange,
  pointerToMediaFraction,
  rangeFromMarks,
  stepTime,
  timeAtTimelineX,
  timelineFraction,
} from "./mediaReview.ts";

describe("letterboxing", () => {
  it("centres a wide video in a tall container with bars above and below", () => {
    expect(containedContentBox({ width: 400, height: 400 }, { width: 1600, height: 900 })).toEqual({
      x: 0,
      y: 87.5,
      width: 400,
      height: 225,
    });
  });

  it("centres a tall video in a wide container with bars at the sides", () => {
    expect(containedContentBox({ width: 800, height: 400 }, { width: 100, height: 200 })).toEqual({
      x: 300,
      y: 0,
      width: 200,
      height: 400,
    });
  });

  it("is empty before the media has a size", () => {
    expect(containedContentBox({ width: 400, height: 400 }, { width: 0, height: 0 }).width).toBe(0);
  });

  it("maps a pointer to fractions of the picture, not the element", () => {
    const content = containedContentBox({ width: 400, height: 400 }, { width: 1600, height: 900 });
    expect(pointerToMediaFraction({ x: 200, y: 200 }, content)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToMediaFraction({ x: 0, y: 87.5 }, content)).toEqual({ x: 0, y: 0 });
  });

  it("clamps a pointer on a bar to the picture's edge and reports it as off the picture", () => {
    const content = containedContentBox({ width: 400, height: 400 }, { width: 1600, height: 900 });
    expect(pointerToMediaFraction({ x: 500, y: 10 }, content)).toEqual({ x: 1, y: 0 });
    expect(isPointOnContent({ x: 200, y: 10 }, content)).toBe(false);
    expect(isPointOnContent({ x: 200, y: 200 }, content)).toBe(true);
  });

  it("converts a box back to pixels inside the picture", () => {
    const content = { x: 0, y: 87.5, width: 400, height: 225 };
    expect(boxToPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, content)).toEqual({
      x: 100,
      y: 200,
      width: 200,
      height: 56.25,
    });
  });
});

describe("boxes", () => {
  it("builds the same box whichever corner the drag started from", () => {
    const expected = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
    expect(boxFromPoints({ x: 0.2, y: 0.1 }, { x: 0.5, y: 0.5 })).toEqual(expected);
    const reversed = boxFromPoints({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.1 });
    expect(reversed.x).toBeCloseTo(expected.x);
    expect(reversed.width).toBeCloseTo(expected.width);
  });

  it("ignores accidental clicks", () => {
    expect(isMeaningfulBox({ x: 0, y: 0, width: 0.005, height: 0.5 })).toBe(false);
    expect(isMeaningfulBox({ x: 0, y: 0, width: 0.1, height: 0.1 })).toBe(true);
  });

  it("moves without leaving the picture", () => {
    const start = { x: 0.6, y: 0.6, width: 0.3, height: 0.3 };
    expect(dragBox(start, "move", { x: 0.5, y: -1 })).toEqual({
      x: 0.7,
      y: 0,
      width: 0.3,
      height: 0.3,
    });
  });

  it("resizes from a corner and an edge", () => {
    const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const corner = dragBox(start, "se", { x: 0.1, y: 0.2 });
    expect(corner.x).toBeCloseTo(0.2);
    expect(corner.width).toBeCloseTo(0.5);
    expect(corner.height).toBeCloseTo(0.6);
    const edge = dragBox(start, "w", { x: -0.1, y: 0.5 });
    expect(edge.x).toBeCloseTo(0.1);
    expect(edge.width).toBeCloseTo(0.5);
    expect(edge.height).toBeCloseTo(0.4);
  });

  it("flips when an edge is dragged across the opposite one", () => {
    const flipped = dragBox({ x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, "e", { x: -0.4, y: 0 });
    expect(flipped.x).toBeCloseTo(0.2);
    expect(flipped.width).toBeCloseTo(0.2);
  });

  it("describes a box in percentages", () => {
    expect(formatBoxPercent({ x: 0.123, y: 0.5, width: 0.25, height: 0.331 })).toBe(
      "x 12%, y 50%, 25% wide, 33% tall",
    );
  });
});

describe("time", () => {
  it("formats timecodes", () => {
    expect(formatTimecode(0)).toBe("0:00.00");
    expect(formatTimecode(65.256)).toBe("1:05.26");
    expect(formatTimecode(3725.5)).toBe("1:02:05.50");
    expect(formatTimecode(Number.NaN)).toBe("0:00.00");
  });

  it("shows a moment once and a range as two times", () => {
    expect(formatTimeRange(3, undefined)).toBe("0:03.00");
    expect(formatTimeRange(3, 3)).toBe("0:03.00");
    expect(formatTimeRange(3, 5.5)).toBe("0:03.00 – 0:05.50");
  });

  it("steps one frame at a time without drifting", () => {
    let time = 0;
    for (let index = 0; index < 30; index += 1) {
      time = stepTime({ current: time, duration: 10, fps: 30, direction: 1, coarse: false });
    }
    expect(time).toBeCloseTo(1, 6);
    expect(
      stepTime({ current: time, duration: 10, fps: 30, direction: -1, coarse: false }),
    ).toBeCloseTo(29 / 30, 6);
  });

  it("snaps a mid-frame playhead to the adjacent frame boundaries", () => {
    expect(
      stepTime({ current: 0.05, duration: 10, fps: 10, direction: 1, coarse: false }),
    ).toBeCloseTo(0.1);
    expect(
      stepTime({ current: 0.05, duration: 10, fps: 10, direction: -1, coarse: false }),
    ).toBeCloseTo(0);
  });

  it("steps a second with shift and falls back to 30 fps", () => {
    expect(stepTime({ current: 2.5, duration: 10, fps: 24, direction: 1, coarse: true })).toBe(3.5);
    expect(
      stepTime({ current: 0, duration: 10, fps: null, direction: 1, coarse: false }),
    ).toBeCloseTo(1 / 30);
  });

  it("stops at both ends of the clip", () => {
    expect(stepTime({ current: 0, duration: 10, fps: 30, direction: -1, coarse: false })).toBe(0);
    expect(
      stepTime({ current: 9.99, duration: 10, fps: 30, direction: 1, coarse: true }),
    ).toBeLessThan(10);
  });
});

describe("timeline", () => {
  it("maps pixels to time and back", () => {
    expect(timeAtTimelineX(150, 300, 20)).toBe(10);
    expect(timeAtTimelineX(-5, 300, 20)).toBe(0);
    expect(timeAtTimelineX(999, 300, 20)).toBe(20);
    expect(timelineFraction(5, 20)).toBe(0.25);
    expect(timelineFraction(5, 0)).toBe(0);
  });

  it("orders and clamps a dragged range", () => {
    expect(normalizeRange(8, 2, 10)).toEqual({ start: 2, end: 8 });
    expect(normalizeRange(-3, 14, 10)).toEqual({ start: 0, end: 10 });
  });

  it("builds a range from marks in either order, or a moment from one mark", () => {
    expect(rangeFromMarks({ markIn: 6, markOut: 2, duration: 10 })).toEqual({ start: 2, end: 6 });
    expect(rangeFromMarks({ markIn: 4, markOut: null, duration: 10 })).toEqual({
      start: 4,
      end: 4,
    });
    expect(rangeFromMarks({ markIn: null, markOut: null, duration: 10 })).toBeNull();
  });

  it("shows a note on its frames and notes with no time always", () => {
    expect(isAnnotationActiveAt({ timeStart: 2, timeEnd: 4 }, 3)).toBe(true);
    expect(isAnnotationActiveAt({ timeStart: 2, timeEnd: 4 }, 4.5)).toBe(false);
    expect(isAnnotationActiveAt({ timeStart: 2 }, 2.03)).toBe(true);
    expect(isAnnotationActiveAt({}, 100)).toBe(true);
  });

  it("cycles playback speed", () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(2)).toBe(0.25);
    expect(nextPlaybackRate(3)).toBe(0.25);
  });
});

describe("mediaReviewKindForPath", () => {
  it("accepts what the server can read and nothing else", () => {
    expect(mediaReviewKindForPath("campaigns/Reel.MP4")).toBe("video");
    expect(mediaReviewKindForPath("a/b.webp")).toBe("image");
    expect(mediaReviewKindForPath("logo.svg")).toBeNull();
    expect(mediaReviewKindForPath("song.mp3")).toBeNull();
    expect(mediaReviewKindForPath("Makefile")).toBeNull();
  });
});

describe("reviewKeyAction", () => {
  const press = (key: string, extra: Partial<Parameters<typeof reviewKeyAction>[0]> = {}) =>
    reviewKeyAction(
      {
        key,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        target: { tagName: "DIV" },
        ...extra,
      },
      true,
    );

  it("maps playback and stepping keys", () => {
    expect(press(" ")).toEqual({ type: "toggle-play" });
    expect(press("ArrowRight")).toEqual({ type: "step", direction: 1, coarse: false });
    expect(press("ArrowLeft", { shiftKey: true })).toEqual({
      type: "step",
      direction: -1,
      coarse: true,
    });
    expect(press(",")).toEqual({ type: "step", direction: -1, coarse: false });
    expect(press(".")).toEqual({ type: "step", direction: 1, coarse: false });
    expect(press("i")).toEqual({ type: "mark-in" });
    expect(press("O")).toEqual({ type: "mark-out" });
  });

  it("leaves typing alone", () => {
    expect(press(" ", { target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(press("i", { target: { tagName: "INPUT" } })).toBeNull();
    expect(press("o", { target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
    expect(press("Escape", { target: { tagName: "TEXTAREA" } })).toBeNull();
  });

  it("lets Space press a focused button and ignores shortcuts with modifiers", () => {
    expect(press(" ", { target: { tagName: "BUTTON" } })).toBeNull();
    expect(press("ArrowRight", { metaKey: true })).toBeNull();
    expect(press("i", { ctrlKey: true })).toBeNull();
  });

  it("only offers Escape for an image", () => {
    const image = (key: string) =>
      reviewKeyAction(
        { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: null },
        false,
      );
    expect(image("Escape")).toEqual({ type: "escape" });
    expect(image(" ")).toBeNull();
    expect(image("i")).toBeNull();
  });
});
