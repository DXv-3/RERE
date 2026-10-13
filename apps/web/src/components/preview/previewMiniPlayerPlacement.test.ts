import { describe, expect, it } from "vite-plus/test";

import {
  dragMiniPlayerPosition,
  keyboardMiniPlayerPosition,
  parseStoredMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_KEY_STEP,
  PREVIEW_MINI_PLAYER_KEY_STEP_LARGE,
} from "./previewMiniPlayerPlacement";

const container = { width: 1000, height: 800 };
const frame = { x: 400, y: 300, width: 320, height: 200 };

describe("parseStoredMiniPlayerPosition", () => {
  it("reads a stored position and rounds it to whole pixels", () => {
    expect(parseStoredMiniPlayerPosition({ x: 120, y: 48 })).toEqual({ x: 120, y: 48 });
    expect(parseStoredMiniPlayerPosition({ x: 120.6, y: 48.2 })).toEqual({ x: 121, y: 48 });
  });

  it.each([
    ["nothing", null],
    ["undefined", undefined],
    ["a string", "12,40"],
    ["an array", [12, 40]],
    ["a missing coordinate", { x: 12 }],
    ["string coordinates", { x: "12", y: "40" }],
    ["NaN", { x: Number.NaN, y: 4 }],
    ["Infinity", { x: 4, y: Number.POSITIVE_INFINITY }],
    ["an absurd coordinate", { x: 4_000_000, y: 4 }],
  ])("falls back to the default corner for %s", (_label, value) => {
    expect(parseStoredMiniPlayerPosition(value)).toBeNull();
  });
});

describe("dragMiniPlayerPosition", () => {
  it("moves the frame by the pointer delta", () => {
    expect(dragMiniPlayerPosition(frame, { x: -150, y: 40 }, container)).toEqual({
      x: 250,
      y: 340,
    });
  });

  it("keeps the whole frame, handle included, inside the container", () => {
    expect(dragMiniPlayerPosition(frame, { x: 5_000, y: 5_000 }, container)).toEqual({
      x: 1000 - 320 - 12,
      y: 800 - 200 - 12,
    });
    expect(dragMiniPlayerPosition(frame, { x: -5_000, y: -5_000 }, container)).toEqual({
      x: 12,
      y: 12,
    });
  });

  it("re-clamps into a container that shrank after the position was stored", () => {
    const stored = { ...frame, x: 900, y: 700 };
    expect(dragMiniPlayerPosition(stored, { x: 0, y: 0 }, { width: 600, height: 500 })).toEqual({
      x: 600 - 320 - 12,
      y: 500 - 200 - 12,
    });
  });
});

describe("keyboardMiniPlayerPosition", () => {
  it("steps in the arrow direction", () => {
    const step = PREVIEW_MINI_PLAYER_KEY_STEP;
    expect(keyboardMiniPlayerPosition(frame, "ArrowLeft", false, container)).toEqual({
      x: 400 - step,
      y: 300,
    });
    expect(keyboardMiniPlayerPosition(frame, "ArrowDown", false, container)).toEqual({
      x: 400,
      y: 300 + step,
    });
  });

  it("takes a larger step with Shift", () => {
    expect(keyboardMiniPlayerPosition(frame, "ArrowRight", true, container)).toEqual({
      x: 400 + PREVIEW_MINI_PLAYER_KEY_STEP_LARGE,
      y: 300,
    });
  });

  it("stops at the container edge", () => {
    const atEdge = { ...frame, x: 12, y: 12 };
    expect(keyboardMiniPlayerPosition(atEdge, "ArrowUp", true, container)).toEqual({
      x: 12,
      y: 12,
    });
  });

  it("ignores keys that are not arrows", () => {
    expect(keyboardMiniPlayerPosition(frame, "Enter", false, container)).toBeNull();
    expect(keyboardMiniPlayerPosition(frame, "a", true, container)).toBeNull();
  });
});

describe("dragMiniPlayerPosition with the control strip", () => {
  // The strip is the top of the frame, so keeping the frame inside the container
  // keeps the strip, the only thing that can be grabbed, on screen too.
  const stripFrame = { x: 400, y: 300, width: 320, height: 232 };

  it("stops the strip at the top edge gap", () => {
    expect(dragMiniPlayerPosition(stripFrame, { x: 0, y: -900 }, container).y).toBe(12);
  });

  it("stops the whole frame, strip included, at the bottom edge gap", () => {
    expect(dragMiniPlayerPosition(stripFrame, { x: 0, y: 900 }, container).y).toBe(800 - 232 - 12);
  });

  it("stops at the side edges", () => {
    expect(dragMiniPlayerPosition(stripFrame, { x: -900, y: 0 }, container).x).toBe(12);
    expect(dragMiniPlayerPosition(stripFrame, { x: 900, y: 0 }, container).x).toBe(1000 - 320 - 12);
  });
});
