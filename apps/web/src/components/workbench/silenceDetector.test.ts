import { expect, it } from "vite-plus/test";

import { audioLevel, createSilenceDetector } from "./silenceDetector";

it("never ends a recording before the first word", () => {
  const finished = createSilenceDetector(2000, 0.02);
  expect(finished(0, 0)).toBe(false);
  expect(finished(0.001, 60_000)).toBe(false);
});

it("ends after a pause that follows speech, and speech resets the pause", () => {
  const finished = createSilenceDetector(2000, 0.02);
  expect(finished(0.2, 1000)).toBe(false);
  expect(finished(0, 2500)).toBe(false);
  expect(finished(0.1, 2900)).toBe(false);
  expect(finished(0, 4800)).toBe(false);
  expect(finished(0, 4900)).toBe(true);
});

it("measures loudness as root mean square", () => {
  expect(audioLevel(new Float32Array())).toBe(0);
  expect(audioLevel(new Float32Array([0, 0, 0]))).toBe(0);
  expect(audioLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
});
