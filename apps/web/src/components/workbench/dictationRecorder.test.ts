import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopNativeDictationEvent } from "@t3tools/contracts";
import type { NativeSpeech } from "./appleDictation";
import { createDictationRecorder, dictationErrorMessage } from "./dictationRecorder";

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  static instances: FakeMediaRecorder[] = [];
  state = "inactive";
  constructor() {
    super();
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
  /** One second of audio arrives. */
  chunk() {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["audio"]) }));
  }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** Lets promise callbacks (blob reads, bridge calls) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const transcribe = vi.fn();
const status = vi.fn();
let clock = 0;
const onTranscript = vi.fn();
const onCancel = vi.fn();
const make = () =>
  createDictationRecorder(
    () => ({ onTranscript, onCancel }),
    () => clock,
  );
const recording = () => FakeMediaRecorder.instances.at(-1)!;
/** Starts a recording and waits until the microphone is open. */
const begin = async (recorder: ReturnType<typeof make>) => {
  await recorder.start();
  expect(recorder.getSnapshot().state).toBe("recording");
};

beforeEach(() => {
  clock = 0;
  FakeMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  });
  vi.stubGlobal("window", {
    desktopBridge: { getDictationStatus: status, transcribeDictation: transcribe },
  });
  status.mockResolvedValue({ available: true, model: "Whisper Large v3 Turbo", reason: null });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("sends live passes as previews and the stopped recording as a final", async () => {
  transcribe.mockResolvedValueOnce("hello wor").mockResolvedValueOnce("hello world");
  const recorder = make();
  await begin(recorder);
  expect(recorder.getSnapshot().model).toBe("Whisper Large v3 Turbo");
  clock = 1000;
  recording().chunk();
  clock = 2000;
  recording().chunk();
  await settle();
  expect(transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), { preview: true });
  expect(recorder.getSnapshot().live).toBe("hello wor");

  recorder.stop();
  await settle();
  // The final call carries no preview flag, so the desktop app never drops it.
  expect(transcribe).toHaveBeenLastCalledWith(expect.any(Uint8Array));
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("hello world");
  expect(recorder.getSnapshot()).toMatchObject({ state: "idle", live: "" });
});

it("waits 1.5 times as long as a slow pass before starting the next preview", async () => {
  const first = deferred<string>();
  transcribe.mockReturnValueOnce(first.promise).mockResolvedValue("more words");
  const recorder = make();
  await begin(recorder);
  clock = 1000;
  recording().chunk();
  clock = 2000;
  recording().chunk();
  await settle();
  expect(transcribe).toHaveBeenCalledTimes(1);

  // A pass is still running: later chunks do not start another.
  clock = 3000;
  recording().chunk();
  clock = 6000;
  first.resolve("first words");
  await settle();
  recording().chunk();
  await settle();
  // The pass took 4 s and started at 2 s, so the next may not start before 8 s: not yet at 6 s.
  expect(transcribe).toHaveBeenCalledTimes(1);

  clock = 8000;
  recording().chunk();
  await settle();
  expect(transcribe).toHaveBeenCalledTimes(2);
});

it("stops previews after a minute and says so", async () => {
  transcribe.mockResolvedValue("some words");
  const recorder = make();
  await begin(recorder);
  clock = 10_000;
  recording().chunk();
  clock = 11_000;
  recording().chunk();
  await settle();
  expect(recorder.getSnapshot()).toMatchObject({ live: "some words", previewPaused: false });

  clock = 61_000;
  recording().chunk();
  await settle();
  expect(recorder.getSnapshot().previewPaused).toBe(true);
  expect(transcribe).toHaveBeenCalledTimes(1);
});

it("lets the user try again straight after a failed transcription", async () => {
  transcribe.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'desktop:dictation-transcribe': DictationError: Local transcription could not finish.",
    ),
  );
  const recorder = make();
  await begin(recorder);
  recorder.stop();
  await settle();
  expect(recorder.getSnapshot()).toMatchObject({
    state: "idle",
    error: "Local transcription could not finish.",
  });
  expect(onTranscript).not.toHaveBeenCalled();

  await begin(recorder);
  expect(FakeMediaRecorder.instances).toHaveLength(2);
  expect(recorder.getSnapshot().error).toBe("");
});

it("toggles between recording and transcribing, and ignores the moments in between", async () => {
  const final = deferred<string>();
  transcribe.mockReturnValueOnce(final.promise);
  const recorder = make();
  recorder.toggle();
  expect(recorder.getSnapshot().state).toBe("starting");
  recorder.toggle();
  expect(FakeMediaRecorder.instances).toHaveLength(0);
  await settle();
  expect(recorder.getSnapshot().state).toBe("recording");

  recorder.toggle();
  expect(recorder.getSnapshot().state).toBe("transcribing");
  recorder.toggle();
  expect(recorder.getSnapshot().state).toBe("transcribing");
  final.resolve("done");
  await settle();
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("done");
});

it("cancelling discards the recording and its transcript", async () => {
  const final = deferred<string>();
  transcribe.mockReturnValueOnce(final.promise);
  const recorder = make();
  await begin(recorder);
  recorder.stop();
  recorder.cancel();
  final.resolve("never wanted");
  await settle();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(recorder.getSnapshot().state).toBe("idle");
});

it("reports a desktop build without dictation by name", async () => {
  vi.stubGlobal("window", {});
  const recorder = make();
  await recorder.start();
  expect(recorder.getSnapshot()).toMatchObject({
    state: "idle",
    error: "Local voice-to-chat is available in the updated CodeWrench desktop app.",
  });
});

it("strips Electron's wrapper from error messages", () => {
  expect(
    dictationErrorMessage(
      new Error(
        "Error invoking remote method 'desktop:dictation-transcribe': Error: No speech was detected.",
      ),
      "fallback",
    ),
  ).toBe("No speech was detected.");
  expect(dictationErrorMessage(new Error("Permission denied"), "fallback")).toBe(
    "Permission denied",
  );
  expect(dictationErrorMessage("nope", "fallback")).toBe("fallback");
});

// Apple's on-device engine, behind the same recorder.
const appleStatus = {
  available: true,
  model: "Apple on-device speech",
  reason: null,
  engine: "apple",
  appleAvailable: true,
  whisperReason: null,
  whisperModel: "Whisper Large v3 Turbo",
};
const fakeNative = () => {
  let listener: (event: DesktopNativeDictationEvent) => void = () => undefined;
  const native = {
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<string>>().mockResolvedValue("hello world"),
    cancel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onEvent: vi.fn((next: typeof listener) => {
      listener = next;
      return () => {
        listener = () => undefined;
      };
    }),
  };
  return { native, emit: (event: DesktopNativeDictationEvent) => listener(event) };
};
const makeApple = (native: NativeSpeech) =>
  createDictationRecorder(
    () => ({ onTranscript, onCancel }),
    () => clock,
    () => native,
  );

it("Apple engine: shows live words, delivers the final on stop, and never opens the microphone itself", async () => {
  status.mockResolvedValue(appleStatus);
  const { native, emit } = fakeNative();
  const recorder = makeApple(native);
  await begin(recorder);
  expect(recorder.getSnapshot().model).toBe("Apple on-device speech");
  emit({ type: "partial", text: " hello wor " });
  expect(recorder.getSnapshot().live).toBe("hello wor");

  recorder.stop();
  expect(recorder.getSnapshot().state).toBe("transcribing");
  await settle();
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("hello world");
  expect(recorder.getSnapshot()).toMatchObject({ state: "idle", live: "" });
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(FakeMediaRecorder.instances).toHaveLength(0);
  expect(transcribe).not.toHaveBeenCalled();
});

it("Apple engine: cancel discards the words and never delivers them", async () => {
  status.mockResolvedValue(appleStatus);
  const { native, emit } = fakeNative();
  const recorder = makeApple(native);
  await begin(recorder);
  emit({ type: "partial", text: "secret" });
  recorder.cancel();
  await settle();
  expect(native.cancel).toHaveBeenCalledTimes(1);
  expect(native.stop).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(recorder.getSnapshot()).toMatchObject({ state: "idle", live: "" });
});

it("Apple engine: falls back to Whisper when Apple's engine is unavailable", async () => {
  status.mockResolvedValue(appleStatus);
  transcribe.mockReset().mockResolvedValue("from whisper");
  const { native } = fakeNative();
  native.start.mockRejectedValue(new Error("[on_device_unavailable] No on-device speech."));
  const recorder = makeApple(native);
  await begin(recorder);
  expect(recorder.getSnapshot().model).toBe("Whisper Large v3 Turbo");
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  recorder.stop();
  await settle();
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("from whisper");
});

it("Apple engine: falls back when the helper is missing, and says why Whisper cannot run if it cannot", async () => {
  status.mockResolvedValue({ ...appleStatus, whisperReason: "Install whisper-cpp and ffmpeg." });
  const { native } = fakeNative();
  native.start.mockRejectedValue(new Error("[helper_missing] No helper."));
  const recorder = makeApple(native);
  await recorder.start();
  expect(recorder.getSnapshot()).toMatchObject({
    state: "idle",
    error: "Install whisper-cpp and ffmpeg.",
  });
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});

it("Apple engine: does not fall back when permission is denied, and tells the user how to fix it", async () => {
  status.mockResolvedValue(appleStatus);
  const { native } = fakeNative();
  native.start.mockRejectedValue(
    new Error(
      "Error invoking remote method 'x': DictationError: [permission_denied] Speech Recognition is off.",
    ),
  );
  const recorder = makeApple(native);
  await recorder.start();
  const snapshot = recorder.getSnapshot();
  expect(snapshot.state).toBe("idle");
  expect(snapshot.error).toContain("System Settings > Privacy & Security > Speech Recognition");
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(FakeMediaRecorder.instances).toHaveLength(0);
});

it("Apple engine: stops by itself on the helper's silence signal only when asked to", async () => {
  status.mockResolvedValue(appleStatus);
  const first = fakeNative();
  const manual = makeApple(first.native);
  await manual.start();
  first.emit({ type: "silence" });
  expect(manual.getSnapshot().state).toBe("recording");

  const second = fakeNative();
  const auto = makeApple(second.native);
  await auto.start({ autoStopOnSilence: true });
  second.emit({ type: "partial", text: "done" });
  second.emit({ type: "silence" });
  await settle();
  expect(second.native.stop).toHaveBeenCalledTimes(1);
  expect(onTranscript).toHaveBeenCalledTimes(1);
});

it("Apple engine: a helper that dies keeps the words heard, or shows the error if there were none", async () => {
  status.mockResolvedValue(appleStatus);
  const heard = fakeNative();
  const a = makeApple(heard.native);
  await a.start();
  heard.emit({ type: "partial", text: "kept" });
  heard.emit({ type: "error", code: "helper_exited", message: "The helper stopped." });
  await settle();
  expect(heard.native.stop).toHaveBeenCalledTimes(1);

  const silent = fakeNative();
  const b = makeApple(silent.native);
  await b.start();
  silent.emit({ type: "error", code: "helper_exited", message: "The helper stopped." });
  expect(b.getSnapshot()).toMatchObject({ state: "idle", error: "The helper stopped." });
  expect(silent.native.stop).not.toHaveBeenCalled();
});

it("Apple engine: cancelling while the permission prompt is up ends the session quietly", async () => {
  status.mockResolvedValue(appleStatus);
  const { native } = fakeNative();
  const pending = deferred<void>();
  native.start.mockReturnValue(pending.promise);
  const recorder = makeApple(native);
  const started = recorder.start();
  await settle();
  recorder.cancel();
  pending.resolve();
  await started;
  expect(native.cancel).toHaveBeenCalled();
  expect(recorder.getSnapshot().state).toBe("idle");
  expect(onTranscript).not.toHaveBeenCalled();
});

it("uses Whisper when the desktop app picked it, even if a native bridge exists", async () => {
  status.mockResolvedValue({ ...appleStatus, engine: "whisper", model: "Whisper Large v3 Turbo" });
  const { native } = fakeNative();
  const recorder = makeApple(native);
  await begin(recorder);
  expect(native.start).not.toHaveBeenCalled();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
});
