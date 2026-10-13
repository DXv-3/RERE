import {
  bridgeNativeSpeech,
  classifyNativeSpeechError,
  nativeSpeechErrorText,
  parseNativeSpeechError,
  type NativeSpeech,
} from "./appleDictation";
import { decidePreview } from "./dictationPreview";
import { audioLevel, createSilenceDetector } from "./silenceDetector";

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface DictationSnapshot {
  readonly state: DictationState;
  readonly error: string;
  /** Friendly name of the Whisper model in use, once a recording has started. */
  readonly model: string;
  /** The words heard so far while recording. Not the draft: the final text arrives through `onTranscript`. */
  readonly live: string;
  /** The recording is too long for live previews; `live` is no longer updated. */
  readonly previewPaused: boolean;
}

export interface DictationHandlers {
  /** The final text of a recording the user stopped. Never called for a cancelled or abandoned one. */
  readonly onTranscript: (text: string) => void;
  /** The user discarded this recording; anything shown for it should be removed. */
  readonly onCancel?: (() => void) | undefined;
}

export interface DictationStartOptions {
  /** Stop and transcribe by itself once the speaker pauses. */
  readonly autoStopOnSilence?: boolean | undefined;
}

export interface DictationRecorder {
  readonly getSnapshot: () => DictationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Opens the microphone and starts recording. Does nothing while a recording is under way. */
  readonly start: (options?: DictationStartOptions) => Promise<void>;
  /** Stops recording and transcribes it; the text arrives through `onTranscript`. */
  readonly stop: () => void;
  /** Starts when idle, stops when recording, and ignores the moments in between. */
  readonly toggle: () => void;
  /** Discards the recording or the transcription in flight. */
  readonly cancel: () => void;
  /** Marks the recorder in use. Call once when it mounts, and `dispose` when it goes away. */
  readonly attach: () => void;
  /** Stops the microphone and drops anything still in flight. */
  readonly dispose: () => void;
}

const DICTATION_UNAVAILABLE_MESSAGE =
  "Local voice-to-chat is available in the updated CodeWrench desktop app.";
const MAX_RECORDING_MS = 180_000;
const SILENCE_POLL_MS = 100;
const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

/** The message of a failed desktop call without Electron's "Error invoking remote method" and error-name prefixes. */
export function dictationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/u, "")
    .trim();
  return message || fallback;
}

const IDLE: DictationSnapshot = {
  state: "idle",
  error: "",
  model: "",
  live: "",
  previewPaused: false,
};

/**
 * One dictation session at a time: opens the microphone, records in one-second chunks, shows
 * live words while recording and delivers the final text to `onTranscript` after `stop`.
 * Plain TypeScript with no React, so a button, a keyboard shortcut or a voice command can all
 * drive it. Browser and desktop-bridge globals are read when a recording starts.
 *
 * Two engines sit behind it. The desktop app says which one applies (`status.engine`). Apple's
 * on-device speech listens to the microphone in the Mac app itself: no `getUserMedia`, no
 * MediaRecorder, words stream in as `live`, and `stop` delivers the final text. If Apple's engine
 * cannot start because it is unavailable (helper missing, language unsupported), Whisper takes
 * over for that recording; if the user denied permission it is reported instead, since Whisper
 * would hide a problem they can fix. Silence auto-stop uses the helper's own silence signal.
 */
export function createDictationRecorder(
  handlers: () => DictationHandlers,
  now: () => number = () => performance.now(),
  nativeSpeech: () => NativeSpeech | undefined = bridgeNativeSpeech,
): DictationRecorder {
  let snapshot = IDLE;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DictationSnapshot>) => {
    const keys = Object.keys(patch) as (keyof DictationSnapshot)[];
    if (keys.every((key) => snapshot[key] === patch[key])) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // A recording belongs to the generation it started in; cancelling or unmounting moves on.
  let generation = 0;
  let busy = false;
  let attached = true;

  let stopListeningForSilence: (() => void) | null = null;
  // The running Apple-engine session, if that is the engine in use.
  let apple: {
    readonly native: NativeSpeech;
    readonly unsubscribe: () => void;
    readonly active: () => boolean;
    stopping: boolean;
  } | null = null;

  const discardApple = () => {
    const session = apple;
    apple = null;
    if (!session) return;
    session.unsubscribe();
    void session.native.cancel().catch(() => undefined);
  };

  const stopApple = () => {
    const session = apple;
    if (!session || session.stopping || snapshot.state !== "recording") return;
    session.stopping = true;
    session.unsubscribe();
    if (timer) clearTimeout(timer);
    set({ state: "transcribing" });
    void session.native
      .stop()
      .then((text) => {
        if (!session.active()) return;
        handlers().onTranscript(text);
        set({ live: "" });
      })
      .catch((error) => {
        if (!session.active()) return;
        const failure = parseNativeSpeechError(dictationErrorMessage(error, ""));
        set({ error: nativeSpeechErrorText(failure.code, failure.message) });
      })
      .finally(() => {
        if (apple === session) apple = null;
        if (session.active()) {
          busy = false;
          set({ state: "idle" });
        }
      });
  };

  // "started": listening. "fallback": Apple's engine is unavailable, use Whisper.
  // "ended": failed with a message shown, or the recording was cancelled meanwhile.
  const startApple = async (
    native: NativeSpeech,
    options: DictationStartOptions | undefined,
    active: () => boolean,
  ): Promise<"started" | "fallback" | "ended"> => {
    // Subscribed before starting so words spoken right away are not missed.
    const session = {
      native,
      active,
      stopping: false,
      unsubscribe: native.onEvent((event) => {
        if (!active()) return;
        if (event.type === "partial") {
          set({ live: event.text.trim() });
        } else if (event.type === "silence") {
          if (options?.autoStopOnSilence) stopApple();
        } else if (snapshot.live) {
          // The helper died, but the words heard so far are still worth keeping.
          stopApple();
        } else {
          generation++;
          busy = false;
          discardApple();
          stopTracks();
          set({ state: "idle", error: nativeSpeechErrorText(event.code, event.message) });
        }
      }),
    };
    apple = session;
    try {
      await native.start();
    } catch (error) {
      if (apple === session) {
        apple = null;
        session.unsubscribe();
      }
      if (!active()) return "ended";
      const failure = parseNativeSpeechError(dictationErrorMessage(error, ""));
      if (classifyNativeSpeechError(failure.code) === "unavailable") return "fallback";
      busy = false;
      set({ state: "idle", error: nativeSpeechErrorText(failure.code, failure.message) });
      return "ended";
    }
    if (!active()) {
      // Cancelled while the system permission prompt was up.
      if (apple === session) apple = null;
      session.unsubscribe();
      void native.cancel().catch(() => undefined);
      return "ended";
    }
    set({ state: "recording" });
    timer = setTimeout(stopApple, MAX_RECORDING_MS);
    return "started";
  };

  const stopTracks = () => {
    stopListeningForSilence?.();
    stopListeningForSilence = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (timer) clearTimeout(timer);
  };

  // Watches the microphone level beside the recording and stops it after a pause in speech.
  const listenForSilence = (media: MediaStream, capture: MediaRecorder) => {
    if (typeof AudioContext === "undefined") return;
    const audio = new AudioContext();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    audio.createMediaStreamSource(media).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const finished = createSilenceDetector();
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      if (finished(audioLevel(samples), now()) && capture.state === "recording") capture.stop();
    }, SILENCE_POLL_MS);
    stopListeningForSilence = () => {
      clearInterval(poll);
      void audio.close().catch(() => undefined);
    };
  };

  const start = async (options?: DictationStartOptions) => {
    if (busy) return;
    busy = true;
    const current = ++generation;
    const active = () => attached && current === generation;
    set({ error: "", live: "", previewPaused: false, state: "starting" });
    const bridge = window.desktopBridge;
    const transcribe = bridge?.transcribeDictation;
    const getStatus = bridge?.getDictationStatus;
    if (!transcribe || !getStatus) {
      busy = false;
      set({ state: "idle", error: DICTATION_UNAVAILABLE_MESSAGE });
      return;
    }
    try {
      const setup = await getStatus();
      if (!active()) return;
      let whisper = { available: setup.available, model: setup.model, reason: setup.reason };
      const native = setup.engine === "apple" ? nativeSpeech() : undefined;
      if (native) {
        set({ model: setup.model });
        const outcome = await startApple(native, options, active);
        if (outcome !== "fallback") return;
        // Whisper's own readiness, since the status described Apple's engine.
        whisper = {
          available: setup.whisperReason == null,
          model: setup.whisperModel ?? "",
          reason: setup.whisperReason ?? null,
        };
      }
      if (!whisper.available) {
        throw new Error(whisper.reason ?? "Local dictation is not configured.");
      }
      set({ model: whisper.model });
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!active()) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const capture = new MediaRecorder(media, { mimeType });
      recorder = capture;
      const chunks: Blob[] = [];
      let size = 0;
      const startedAt = now();
      // Live preview bookkeeping: one pass at a time, spaced by how long the last one took.
      let previewing = false;
      let lastPreviewStart: number | null = null;
      let lastPreviewMs: number | null = null;
      capture.addEventListener("dataavailable", (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
          if (size > MAX_RECORDING_BYTES && capture.state === "recording") capture.stop();
        }
        if (!active() || capture.state !== "recording") return;
        const at = now();
        const decision = decidePreview({
          recordedMs: at - startedAt,
          sinceLastStartMs: lastPreviewStart === null ? null : at - lastPreviewStart,
          lastPassMs: lastPreviewMs,
          inFlight: previewing,
          chunkCount: chunks.length,
        });
        if (decision === "paused") {
          set({ previewPaused: true });
          return;
        }
        if (decision === "wait") return;
        previewing = true;
        lastPreviewStart = at;
        void new Blob(chunks, { type: mimeType })
          .arrayBuffer()
          .then((buffer) => transcribe(new Uint8Array(buffer), { preview: true }))
          .then((text) => {
            if (active() && capture.state === "recording" && text.trim()) {
              set({ live: text.trim() });
            }
          })
          // A failed or dropped preview is not worth interrupting the recording for.
          .catch(() => undefined)
          .finally(() => {
            lastPreviewMs = now() - at;
            previewing = false;
          });
      });
      capture.addEventListener("error", () => {
        if (!active()) return;
        generation++;
        busy = false;
        stopTracks();
        if (attached) {
          set({ state: "idle", error: "Microphone recording stopped unexpectedly. Please retry." });
        }
      });
      capture.addEventListener(
        "stop",
        () => {
          if (!active()) return;
          stopTracks();
          set({ state: "transcribing" });
          void new Blob(chunks, { type: mimeType })
            .arrayBuffer()
            .then((buffer) => (active() ? transcribe(new Uint8Array(buffer)) : undefined))
            .then((text) => {
              if (active() && text !== undefined) handlers().onTranscript(text);
              if (active()) set({ live: "" });
            })
            .catch((error) => {
              if (active()) {
                set({ error: dictationErrorMessage(error, "Transcription failed.") });
              }
            })
            .finally(() => {
              if (active()) {
                busy = false;
                set({ state: "idle" });
              }
            });
        },
        { once: true },
      );
      capture.start(1000);
      if (options?.autoStopOnSilence) listenForSilence(media, capture);
      set({ state: "recording" });
      timer = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, MAX_RECORDING_MS);
    } catch (error) {
      if (!active()) return;
      busy = false;
      stopTracks();
      if (attached) {
        set({
          state: "idle",
          error: dictationErrorMessage(error, "Microphone access failed."),
        });
      }
    }
  };

  const stop = () => {
    if (apple) stopApple();
    else if (recorder?.state === "recording") recorder.stop();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    toggle: () => {
      if (snapshot.state === "idle") void start();
      else if (snapshot.state === "recording") stop();
    },
    cancel: () => {
      generation++;
      busy = false;
      // Cancelling discards what Apple's engine heard; stopping would deliver it.
      if (apple) discardApple();
      else stop();
      stopTracks();
      handlers().onCancel?.();
      set({ live: "", previewPaused: false, state: "idle" });
    },
    attach: () => {
      attached = true;
    },
    dispose: () => {
      attached = false;
      generation++;
      busy = false;
      discardApple();
      stop();
      stopTracks();
    },
  };
}
