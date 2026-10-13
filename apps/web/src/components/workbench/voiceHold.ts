import type { DictationRecorder } from "./dictationRecorder";

/**
 * The voice key: one key pressed anywhere on the computer. While this window has focus and
 * a draft is on screen, the words go into that draft; otherwise they start a new thread.
 * The desktop app reports the key; a window event lets whichever draft is on screen claim it.
 */
export const VOICE_HOLD_EVENT = "codewrench:voice-hold";

export type VoiceHoldDetail =
  | {
      /**
       * `press` is the key going down when tapping and holding both work: it starts an idle
       * recorder and finishes one that is recording. `start` is the key going down in
       * hold-only mode; `toggle` is a tap from a shortcut, which has no key-down of its own.
       */
      readonly phase: "press" | "start" | "toggle";
      /** First pass: only the draft the user is typing in may claim the key. */
      readonly requireFocus: boolean;
      /** A tap-started recording may finish by itself after a pause in speech. */
      readonly autoStop: boolean;
      claimed: boolean;
    }
  | {
      /** `keep` ends a quick tap: the recording it started carries on until the next press. */
      readonly phase: "end" | "cancel" | "keep";
    };

type HoldTarget = Pick<EventTarget, "dispatchEvent">;

/** Offers the key to the drafts on screen. False when none took it. */
export function offerVoiceHold(
  phase: "press" | "start" | "toggle",
  autoStop: boolean,
  target: HoldTarget = window,
): boolean {
  for (const requireFocus of [true, false]) {
    const detail: VoiceHoldDetail = { phase, requireFocus, autoStop, claimed: false };
    target.dispatchEvent(new CustomEvent(VOICE_HOLD_EVENT, { detail }));
    if (detail.claimed) return true;
  }
  return false;
}

export function finishVoiceHold(
  phase: "end" | "cancel" | "keep",
  target: HoldTarget = window,
): void {
  const detail: VoiceHoldDetail = { phase };
  target.dispatchEvent(new CustomEvent(VOICE_HOLD_EVENT, { detail }));
}

type Releasable = Pick<DictationRecorder, "getSnapshot" | "stop" | "cancel">;

/**
 * Ends a recording the key started. Finishing before the microphone opened leaves nothing
 * to transcribe, so that discards it, the same as another key joining a hold.
 */
export function releaseHeldRecording(recorder: Releasable, phase: "end" | "cancel"): void {
  const { state } = recorder.getSnapshot();
  if (phase === "end" && state === "recording") recorder.stop();
  else if (state === "starting" || state === "recording") recorder.cancel();
}

/** A tap: starts an idle recorder, finishes one that is recording. */
export function tapRecording(
  recorder: Releasable & Pick<DictationRecorder, "start">,
  autoStop: boolean,
): void {
  if (recorder.getSnapshot().state === "idle") {
    void recorder.start({ autoStopOnSilence: autoStop });
  } else releaseHeldRecording(recorder, "end");
}

/** Whether the text field beside this dictation control is the one being typed in. */
export function draftHasFocus(control: Element): boolean {
  const editable = 'textarea, input, [contenteditable="true"]';
  for (let node = control.parentElement; node; node = node.parentElement) {
    if (node.querySelector(editable)) return node.contains(document.activeElement);
  }
  return false;
}
