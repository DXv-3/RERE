import { describe, expect, it, vi } from "vite-plus/test";

import type { DictationState } from "./dictationRecorder";
import {
  finishVoiceHold,
  offerVoiceHold,
  releaseHeldRecording,
  tapRecording,
  VOICE_HOLD_EVENT,
  type VoiceHoldDetail,
} from "./voiceHold";

const recorderIn = (state: DictationState) => ({
  getSnapshot: () => ({ state, error: "", model: "", live: "", previewPaused: false }),
  stop: vi.fn(),
  cancel: vi.fn(),
});

const detailOf = (event: Event) => (event as CustomEvent<VoiceHoldDetail>).detail;

describe("voice hold", () => {
  it("offers the hold to the focused draft before any other draft", () => {
    const target = new EventTarget();
    const passes: boolean[] = [];
    target.addEventListener(VOICE_HOLD_EVENT, (event) => {
      const detail = detailOf(event);
      if (!("claimed" in detail)) return;
      passes.push(detail.requireFocus);
      if (!detail.requireFocus) detail.claimed = true;
    });
    expect(offerVoiceHold("start", false, target)).toBe(true);
    expect(passes).toEqual([true, false]);
  });

  it("stops offering once a draft claims it, and reports when none does", () => {
    const claimed = new EventTarget();
    const seen = vi.fn((event: Event) => {
      const detail = detailOf(event);
      if ("claimed" in detail) detail.claimed = true;
    });
    claimed.addEventListener(VOICE_HOLD_EVENT, seen);
    expect(offerVoiceHold("toggle", true, claimed)).toBe(true);
    expect(seen).toHaveBeenCalledOnce();
    expect(offerVoiceHold("start", false, new EventTarget())).toBe(false);
  });

  it("tells drafts when the key is released or the hold is spoiled", () => {
    const target = new EventTarget();
    const phases: string[] = [];
    target.addEventListener(VOICE_HOLD_EVENT, (event) => phases.push(detailOf(event).phase));
    finishVoiceHold("end", target);
    finishVoiceHold("cancel", target);
    finishVoiceHold("keep", target);
    expect(phases).toEqual(["end", "cancel", "keep"]);
  });

  it("transcribes on release, and discards a hold that never recorded or was spoiled", () => {
    const recording = recorderIn("recording");
    releaseHeldRecording(recording, "end");
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(recording.cancel).not.toHaveBeenCalled();

    const starting = recorderIn("starting");
    releaseHeldRecording(starting, "end");
    expect(starting.cancel).toHaveBeenCalledOnce();

    const spoiled = recorderIn("recording");
    releaseHeldRecording(spoiled, "cancel");
    expect(spoiled.cancel).toHaveBeenCalledOnce();
    expect(spoiled.stop).not.toHaveBeenCalled();

    // A transcription already under way is left to finish.
    const transcribing = recorderIn("transcribing");
    releaseHeldRecording(transcribing, "cancel");
    expect(transcribing.cancel).not.toHaveBeenCalled();
  });

  it("a tap starts an idle recorder and finishes one that is recording", () => {
    const idle = { ...recorderIn("idle"), start: vi.fn(async () => undefined) };
    tapRecording(idle, true);
    expect(idle.start).toHaveBeenCalledWith({ autoStopOnSilence: true });

    const recording = { ...recorderIn("recording"), start: vi.fn(async () => undefined) };
    tapRecording(recording, true);
    expect(recording.start).not.toHaveBeenCalled();
    expect(recording.stop).toHaveBeenCalledOnce();
  });
});
