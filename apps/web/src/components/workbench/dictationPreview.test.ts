import { expect, it } from "vite-plus/test";
import { decidePreview, PREVIEW_MAX_RECORDING_MS } from "./dictationPreview";

const base = {
  recordedMs: 5000,
  sinceLastStartMs: null,
  lastPassMs: null,
  inFlight: false,
  chunkCount: 5,
};

it("starts the first preview as soon as there is audio to hear", () => {
  expect(decidePreview(base)).toBe("start");
  expect(decidePreview({ ...base, chunkCount: 1 })).toBe("wait");
});

it("never overlaps passes", () => {
  expect(decidePreview({ ...base, inFlight: true, sinceLastStartMs: 60_000 })).toBe("wait");
});

it("waits at least a second, allowing for timer jitter", () => {
  const fast = { ...base, lastPassMs: 200 };
  expect(decidePreview({ ...fast, sinceLastStartMs: 400 })).toBe("wait");
  expect(decidePreview({ ...fast, sinceLastStartMs: 995 })).toBe("start");
});

it("waits 1.5 times as long as the previous pass took", () => {
  const slow = { ...base, lastPassMs: 4000 };
  expect(decidePreview({ ...slow, sinceLastStartMs: 5000 })).toBe("wait");
  expect(decidePreview({ ...slow, sinceLastStartMs: 6000 })).toBe("start");
});

it("stops previewing once the recording is over a minute, even when idle", () => {
  expect(decidePreview({ ...base, recordedMs: PREVIEW_MAX_RECORDING_MS })).toBe("start");
  expect(decidePreview({ ...base, recordedMs: PREVIEW_MAX_RECORDING_MS + 1 })).toBe("paused");
  expect(decidePreview({ ...base, recordedMs: 90_000, inFlight: true, sinceLastStartMs: 0 })).toBe(
    "paused",
  );
});
