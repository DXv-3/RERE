import { expect, it } from "vite-plus/test";
import { createVoiceWorkObserver } from "./workUpdates.ts";
const empty = { messages: [], runs: [], runtimeRequests: [] };
const reply = {
  id: "reply",
  runId: "run",
  role: "assistant",
  text: "The fix is tested.",
  streaming: false,
};
it("does not announce old results when a call starts", () => {
  const old = { ...empty, messages: [reply], runs: [{ id: "run", status: "completed" }] };
  expect(createVoiceWorkObserver(old)(old)).toEqual([]);
});
it("keeps progress quiet and speaks the final result once", () => {
  const observe = createVoiceWorkObserver(empty);
  const working = { ...empty, messages: [reply], runs: [{ id: "run", status: "running" }] };
  expect(observe(working)).toEqual([{ text: "Agent progress: The fix is tested.", speak: false }]);
  const done = { ...working, runs: [{ id: "run", status: "completed" }] };
  expect(observe(done)).toEqual([{ text: "Agent run completed. The fix is tested.", speak: true }]);
  expect(observe(done)).toEqual([]);
});
it("reports failed work as failed and surfaces pending approvals once", () => {
  const observe = createVoiceWorkObserver(empty);
  const failed = {
    ...empty,
    runs: [{ id: "run", status: "failed" }],
    runtimeRequests: [{ id: "approval", status: "pending" }],
  };
  const updates = observe(failed);
  expect(updates[0]?.text).toContain("run failed");
  expect(updates[1]?.text).toContain("approval");
  expect(observe(failed)).toEqual([]);
});
it("does not speak an incomplete streaming response even if the run ended", () => {
  const observe = createVoiceWorkObserver(empty);
  const state = {
    ...empty,
    messages: [{ ...reply, streaming: true }],
    runs: [{ id: "run", status: "completed" }],
  };
  expect(observe(state)).toEqual([]);
  expect(observe({ ...state, messages: [reply] }).some((update) => update.speak)).toBe(true);
});

it("can speak progress directly without announcing a final reply twice", () => {
  const observe = createVoiceWorkObserver(empty, { speakProgress: true });
  const working = { ...empty, messages: [reply], runs: [{ id: "run", status: "running" }] };
  expect(observe(working)[0]?.speak).toBe(true);
  const final = { ...reply, id: "final", text: "All checks passed." };
  const done = { ...empty, messages: [reply, final], runs: [{ id: "run", status: "completed" }] };
  expect(observe(done)).toEqual([{ text: "Agent run completed. All checks passed.", speak: true }]);
  expect(observe(done)).toEqual([]);
});
