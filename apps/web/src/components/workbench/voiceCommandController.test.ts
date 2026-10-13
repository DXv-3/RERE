import type { DesktopVoiceOverlayState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DictationSnapshot, DictationState } from "./dictationRecorder";
import { createVoiceCommandController, type VoiceCommandSettings } from "./voiceCommandController";

function harness(
  settings: Partial<VoiceCommandSettings> = {},
  options: { focused?: boolean; draftClaims?: boolean; startThread?: () => Promise<void> } = {},
) {
  let state: DictationState = "idle";
  const snapshot = (patch: Partial<DictationSnapshot> = {}): DictationSnapshot => ({
    state,
    error: "",
    model: "",
    live: "",
    previewPaused: false,
    ...patch,
  });
  const recorder = {
    getSnapshot: () => snapshot(),
    start: vi.fn(async () => {
      state = "recording";
    }),
    stop: vi.fn(() => {
      state = "transcribing";
    }),
    cancel: vi.fn(() => {
      state = "idle";
    }),
  };
  const overlays: (DesktopVoiceOverlayState | null)[] = [];
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const offerDraft = vi.fn(() => options.draftClaims ?? false);
  const finishDraft = vi.fn();
  const startThread = vi.fn(options.startThread ?? (async () => undefined));
  const controller = createVoiceCommandController({
    recorder,
    settings: () => ({ autoStop: true, sendDelay: true, sounds: true, ...settings }),
    hasFocus: () => options.focused ?? false,
    offerDraft,
    finishDraft,
    startThread,
    overlay: (next) => overlays.push(next),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  return {
    controller,
    recorder,
    overlays,
    offerDraft,
    finishDraft,
    startThread,
    snapshot,
    last: () => overlays.at(-1) ?? null,
    pending: () => timers.filter((timer) => !timer.cleared),
    setState: (next: DictationState) => {
      state = next;
    },
  };
}
const runTimers = (h: ReturnType<typeof harness>, count: number) => {
  for (let index = 0; index < count; index++) {
    const next = h.pending().find((timer) => !(timer as { done?: boolean }).done);
    if (!next) return;
    (next as { done?: boolean }).done = true;
    next.cleared = true;
    next.run();
  }
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("voice command controller", () => {
  it("tap listens, a second tap finishes, and the command waits before it is sent", async () => {
    const h = harness();
    h.controller.onAction("voice-key-tap");
    expect(h.recorder.start).toHaveBeenCalledWith({ autoStopOnSilence: true });
    expect(h.last()).toMatchObject({ phase: "listening", sound: "start" });

    h.controller.onAction("voice-key-tap");
    expect(h.recorder.stop).toHaveBeenCalledOnce();
    h.controller.onRecorderChange(h.snapshot({ live: "spin up" }));
    expect(h.last()).toMatchObject({ phase: "transcribing", text: "spin up", sound: "stop" });

    h.controller.onTranscript(" Spin up a new thread. ");
    expect(h.last()).toMatchObject({ phase: "sending", text: "Spin up a new thread." });
    expect(h.last()?.title).toContain("Sending in 3s");
    expect(h.startThread).not.toHaveBeenCalled();

    runTimers(h, 2);
    expect(h.last()?.title).toContain("Sending in 1s");
    runTimers(h, 1);
    expect(h.startThread).toHaveBeenCalledWith("Spin up a new thread.");
    await flush();
    expect(h.last()).toMatchObject({ phase: "done", title: "Thread started" });
    runTimers(h, 1);
    expect(h.last()).toBeNull();
  });

  it("a tap during the wait sends at once, and cancelling during it sends nothing", async () => {
    const sendNow = harness();
    sendNow.controller.onAction("voice-key-tap");
    sendNow.controller.onTranscript("ship it");
    sendNow.controller.onAction("voice-key-tap");
    expect(sendNow.startThread).toHaveBeenCalledWith("ship it");
    expect(sendNow.pending()).toHaveLength(0);

    const cancelled = harness();
    cancelled.controller.onAction("voice-key-tap");
    cancelled.controller.onTranscript("delete everything");
    cancelled.controller.onAction("voice-cancel");
    expect(cancelled.last()).toBeNull();
    expect(cancelled.pending()).toHaveLength(0);
    expect(cancelled.startThread).not.toHaveBeenCalled();
    // The next tap starts a fresh command.
    cancelled.controller.onAction("voice-key-tap");
    expect(cancelled.last()).toMatchObject({ phase: "listening" });
  });

  it("sends straight away when the wait is switched off, and stays quiet without sounds", () => {
    const h = harness({ sendDelay: false, sounds: false });
    h.controller.onAction("voice-key-tap");
    expect(h.last()).not.toHaveProperty("sound");
    h.controller.onTranscript("go");
    expect(h.startThread).toHaveBeenCalledWith("go");
  });

  it("cancelling while listening discards the recording and hides the pill", () => {
    const h = harness();
    h.controller.onAction("voice-key-tap");
    h.controller.onAction("voice-cancel");
    expect(h.recorder.cancel).toHaveBeenCalledOnce();
    h.controller.onRecorderCancel();
    expect(h.last()).toBeNull();
  });

  it("gives a tap to the draft on screen when this window has focus", () => {
    const h = harness({}, { focused: true, draftClaims: true });
    h.controller.onAction("voice-key-tap");
    expect(h.offerDraft).toHaveBeenCalledWith("toggle", true);
    expect(h.recorder.start).not.toHaveBeenCalled();
    expect(h.overlays).toHaveLength(0);

    // Without focus the draft is never asked: the words start a thread.
    const away = harness({}, { focused: false, draftClaims: true });
    away.controller.onAction("voice-key-tap");
    expect(away.offerDraft).not.toHaveBeenCalled();
    expect(away.recorder.start).toHaveBeenCalledOnce();
  });

  it("hold mode records while the key is down and never stops on a pause", () => {
    const h = harness();
    h.controller.onAction("voice-hold-start");
    expect(h.recorder.start).toHaveBeenCalledWith({ autoStopOnSilence: false });
    expect(h.last()?.title).toContain("release to send");
    h.controller.onAction("voice-hold-end");
    expect(h.recorder.stop).toHaveBeenCalledOnce();

    const spoiled = harness();
    spoiled.controller.onAction("voice-hold-start");
    spoiled.controller.onAction("voice-hold-cancel");
    expect(spoiled.recorder.cancel).toHaveBeenCalledOnce();
    expect(spoiled.recorder.stop).not.toHaveBeenCalled();
  });

  it("a held key the draft took is finished in the draft", () => {
    const h = harness({}, { focused: true, draftClaims: true });
    h.controller.onAction("voice-hold-start");
    h.controller.onAction("voice-hold-end");
    expect(h.finishDraft).toHaveBeenCalledWith("end");
    expect(h.recorder.start).not.toHaveBeenCalled();
  });

  it("shows why a command failed, and says nothing was sent when the thread cannot start", async () => {
    const mic = harness();
    mic.controller.onAction("voice-key-tap");
    mic.setState("idle");
    mic.controller.onRecorderChange(mic.snapshot({ error: "Microphone access failed." }));
    expect(mic.last()).toMatchObject({ phase: "error", text: "Microphone access failed." });

    const failing = harness(
      { sendDelay: false },
      { startThread: () => Promise.reject(new Error("Choose a default model in Settings first.")) },
    );
    failing.controller.onAction("voice-key-tap");
    failing.controller.onTranscript("go");
    await flush();
    expect(failing.last()).toMatchObject({
      phase: "error",
      title: "Voice command not sent",
      text: "Choose a default model in Settings first.",
    });
  });

  it("ignores an empty transcript and a second key press while one command is under way", () => {
    const h = harness();
    h.controller.onAction("voice-key-tap");
    h.controller.onTranscript("   ");
    expect(h.last()).toBeNull();
    expect(h.startThread).not.toHaveBeenCalled();

    h.controller.onAction("voice-key-tap");
    h.setState("transcribing");
    h.controller.onRecorderChange(h.snapshot());
    h.controller.onAction("voice-key-tap");
    expect(h.recorder.start).toHaveBeenCalledTimes(2);
    expect(h.recorder.stop).not.toHaveBeenCalled();
  });

  it("one key both taps and holds: a held press ends on release, a quick tap carries on", () => {
    const held = harness();
    held.controller.onAction("voice-key-press");
    expect(held.recorder.start).toHaveBeenCalledOnce();
    expect(held.last()).toMatchObject({ phase: "listening" });
    // Letting go after holding finishes the recording.
    held.controller.onAction("voice-hold-end");
    expect(held.recorder.stop).toHaveBeenCalledOnce();

    const tapped = harness();
    tapped.controller.onAction("voice-key-press");
    // A quick release leaves it listening.
    tapped.controller.onAction("voice-key-tap");
    expect(tapped.recorder.stop).not.toHaveBeenCalled();
    expect(tapped.recorder.start).toHaveBeenCalledOnce();
    // The next press finishes it, and that press's own release does nothing more.
    tapped.controller.onAction("voice-key-press");
    expect(tapped.recorder.stop).toHaveBeenCalledOnce();
    tapped.controller.onAction("voice-hold-end");
    tapped.controller.onAction("voice-key-tap");
    expect(tapped.recorder.stop).toHaveBeenCalledOnce();
    expect(tapped.recorder.start).toHaveBeenCalledOnce();
  });

  it("another key joining a press discards what that press started", () => {
    const h = harness();
    h.controller.onAction("voice-key-press");
    h.controller.onAction("voice-hold-cancel");
    expect(h.recorder.cancel).toHaveBeenCalledOnce();
    expect(h.recorder.stop).not.toHaveBeenCalled();
  });

  it("a press goes to the draft on screen, which is told how the press ended", () => {
    const h = harness({}, { focused: true, draftClaims: true });
    h.controller.onAction("voice-key-press");
    expect(h.offerDraft).toHaveBeenCalledWith("press", true);
    expect(h.recorder.start).not.toHaveBeenCalled();
    h.controller.onAction("voice-key-tap");
    expect(h.finishDraft).toHaveBeenLastCalledWith("keep");
    h.controller.onAction("voice-key-press");
    h.controller.onAction("voice-hold-end");
    expect(h.finishDraft).toHaveBeenLastCalledWith("end");
  });

  it("a press during the wait sends at once", () => {
    const h = harness();
    h.controller.onAction("voice-key-press");
    h.controller.onAction("voice-hold-end");
    h.controller.onTranscript("ship it");
    h.controller.onAction("voice-key-press");
    expect(h.startThread).toHaveBeenCalledWith("ship it");
    h.controller.onAction("voice-key-tap");
    expect(h.recorder.start).toHaveBeenCalledOnce();
  });
});
