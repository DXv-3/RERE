import type { DesktopVoiceOverlayState } from "@t3tools/contracts";

import type { DictationRecorder, DictationSnapshot } from "./dictationRecorder";
import { releaseHeldRecording } from "./voiceHold";

/** Seconds a spoken command waits before it starts a thread, so a misheard one can be stopped. */
const VOICE_SEND_DELAY_SECONDS = 3;
const DONE_VISIBLE_MS = 2500;
const ERROR_VISIBLE_MS = 5000;

export interface VoiceCommandSettings {
  readonly autoStop: boolean;
  readonly sendDelay: boolean;
  readonly sounds: boolean;
}

export interface VoiceCommandDeps {
  readonly recorder: Pick<DictationRecorder, "getSnapshot" | "start" | "stop" | "cancel">;
  readonly settings: () => VoiceCommandSettings;
  /** Whether this window is the one the user is working in. */
  readonly hasFocus: () => boolean;
  /** Offers the key to a draft on screen; true when one took it. */
  readonly offerDraft: (phase: "press" | "start" | "toggle", autoStop: boolean) => boolean;
  readonly finishDraft: (phase: "end" | "cancel" | "keep") => void;
  readonly startThread: (text: string) => Promise<void>;
  /** Shows the pill above every app; null hides it. */
  readonly overlay: (state: DesktopVoiceOverlayState | null) => void;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

type Phase = "idle" | "listening" | "transcribing" | "countdown" | "sending";

/**
 * The voice key outside a draft: listen, transcribe, wait a moment, start a thread. One
 * command at a time. A tap starts it and a second tap finishes it (or sends at once during
 * the wait); in hold mode the key going down and up does the same. Plain TypeScript so the
 * whole flow can be tested without a window.
 */
export function createVoiceCommandController(deps: VoiceCommandDeps) {
  let phase: Phase = "idle";
  // In hold mode, where the held key's words are going.
  let hold: "draft" | "command" | null = null;
  // While the key is down in tap-or-hold mode: who took the press. `started` means this press
  // began a command recording, so letting go after a hold finishes it; `done` means the press
  // already did its job (finished a recording or sent early) and its release changes nothing.
  let press: "draft" | "started" | "done" | null = null;
  let pendingText = "";
  let secondsLeft = 0;
  let countdownTimer: unknown = null;
  let hideTimer: unknown = null;

  const show = (state: DesktopVoiceOverlayState) => {
    if (hideTimer !== null) deps.clearTimer(hideTimer);
    hideTimer = null;
    deps.overlay(state);
  };
  const hide = () => {
    if (hideTimer !== null) deps.clearTimer(hideTimer);
    hideTimer = null;
    deps.overlay(null);
  };
  const showBriefly = (state: DesktopVoiceOverlayState, ms: number) => {
    show(state);
    hideTimer = deps.setTimer(() => {
      hideTimer = null;
      deps.overlay(null);
    }, ms);
  };
  const stopCountdown = () => {
    if (countdownTimer !== null) deps.clearTimer(countdownTimer);
    countdownTimer = null;
  };

  const listeningTitle = () =>
    hold === "command"
      ? "Listening · release to send"
      : press === "started"
        ? "Listening · let go, or tap again, to send"
        : "Listening · tap again to send";

  const listen = () => {
    const { autoStop, sounds } = deps.settings();
    phase = "listening";
    show({
      phase: "listening",
      title: listeningTitle(),
      text: "",
      ...(sounds ? { sound: "start" as const } : {}),
    });
    // A held key says when the speaker is done; only a tap needs the pause to say it.
    void deps.recorder.start({ autoStopOnSilence: autoStop && hold === null });
  };

  const send = () => {
    stopCountdown();
    const text = pendingText;
    phase = "sending";
    // Past the point of stopping: the pill offers no cancel while the thread starts.
    show({ phase: "transcribing", title: "Starting a thread…", text });
    deps.startThread(text).then(
      () => {
        phase = "idle";
        showBriefly({ phase: "done", title: "Thread started", text }, DONE_VISIBLE_MS);
      },
      (cause: unknown) => {
        phase = "idle";
        showBriefly(
          {
            phase: "error",
            title: "Voice command not sent",
            text: cause instanceof Error ? cause.message : "The thread could not be started.",
          },
          ERROR_VISIBLE_MS,
        );
      },
    );
  };

  const tick = () => {
    countdownTimer = null;
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      send();
      return;
    }
    showCountdown();
    countdownTimer = deps.setTimer(tick, 1000);
  };
  const showCountdown = () =>
    show({
      phase: "sending",
      title: `Sending in ${secondsLeft}s · Esc cancels · tap to send now`,
      text: pendingText,
    });

  return {
    /** The words are ready. */
    onTranscript(text: string) {
      if (phase !== "listening" && phase !== "transcribing") return;
      pendingText = text.trim();
      if (!pendingText) {
        phase = "idle";
        hide();
        return;
      }
      if (!deps.settings().sendDelay) {
        send();
        return;
      }
      phase = "countdown";
      secondsLeft = VOICE_SEND_DELAY_SECONDS;
      showCountdown();
      countdownTimer = deps.setTimer(tick, 1000);
    },

    /** The recording was discarded. */
    onRecorderCancel() {
      if (phase !== "listening" && phase !== "transcribing") return;
      phase = "idle";
      hide();
    },

    /** The recorder moved on: new live words, transcription under way, or a failure. */
    onRecorderChange(snapshot: DictationSnapshot) {
      if (phase === "listening" && snapshot.state === "transcribing") {
        phase = "transcribing";
        show({
          phase: "transcribing",
          title: "Transcribing…",
          text: snapshot.live,
          ...(deps.settings().sounds ? { sound: "stop" as const } : {}),
        });
      } else if (phase === "listening" && snapshot.state !== "idle") {
        show({ phase: "listening", title: listeningTitle(), text: snapshot.live });
      } else if (
        (phase === "listening" || phase === "transcribing") &&
        snapshot.state === "idle" &&
        snapshot.error
      ) {
        phase = "idle";
        showBriefly(
          { phase: "error", title: "Voice command failed", text: snapshot.error },
          ERROR_VISIBLE_MS,
        );
      }
    },

    /** An action sent by the desktop app: the voice key, or the pill's cancel. */
    onAction(action: string) {
      const autoStop = deps.settings().autoStop;
      if (action === "voice-key-press") {
        if (press !== null) return;
        if (phase === "countdown") {
          send();
          press = "done";
        } else if (phase === "listening") {
          releaseHeldRecording(deps.recorder, "end");
          press = "done";
        } else if (phase !== "idle") press = "done";
        else if (deps.hasFocus() && deps.offerDraft("press", autoStop)) press = "draft";
        else {
          press = "started";
          listen();
        }
      } else if (action === "voice-key-tap" && press !== null) {
        // The quick release of a press: whatever it started carries on.
        if (press === "draft") deps.finishDraft("keep");
        press = null;
      } else if (
        (action === "voice-hold-end" || action === "voice-hold-cancel") &&
        press !== null
      ) {
        const end = action === "voice-hold-end" ? "end" : "cancel";
        if (press === "draft") deps.finishDraft(end);
        else if (press === "started" && phase === "listening") {
          releaseHeldRecording(deps.recorder, end);
        }
        press = null;
      } else if (action === "voice-key-tap") {
        if (phase === "countdown") send();
        else if (phase === "listening") releaseHeldRecording(deps.recorder, "end");
        else if (phase === "idle" && !(deps.hasFocus() && deps.offerDraft("toggle", autoStop))) {
          listen();
        }
      } else if (action === "voice-hold-start") {
        if (phase !== "idle" || hold !== null) return;
        if (deps.hasFocus() && deps.offerDraft("start", false)) hold = "draft";
        else {
          hold = "command";
          listen();
        }
      } else if (action === "voice-hold-end" || action === "voice-hold-cancel") {
        const end = action === "voice-hold-end" ? "end" : "cancel";
        if (hold === "draft") deps.finishDraft(end);
        else if (hold === "command" && phase === "listening") {
          releaseHeldRecording(deps.recorder, end);
        }
        hold = null;
      } else if (action === "voice-cancel") {
        if (phase === "countdown") {
          stopCountdown();
          phase = "idle";
          hide();
        } else if (phase === "listening") deps.recorder.cancel();
      }
    },

    dispose() {
      stopCountdown();
      hide();
      phase = "idle";
      hold = null;
      press = null;
    },
  };
}
