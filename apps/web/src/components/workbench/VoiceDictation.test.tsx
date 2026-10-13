import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { VoiceDictation } from "./VoiceDictation";

class Recording extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  static instances: Recording[] = [];
  state = "inactive";
  constructor() {
    super();
    Recording.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer;
const onTranscript = vi.fn();
const stop = vi.fn();
const getUserMedia = vi.fn();
const transcribe = vi.fn();
const status = vi.fn();
const button = (title: string) =>
  renderer.root
    .findAllByType("button")
    .find((b) => b.props.title === title || b.props["aria-label"] === title)!;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MediaRecorder", Recording);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("window", {
    desktopBridge: { getDictationStatus: status, transcribeDictation: transcribe },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  status.mockResolvedValue({ available: true, model: "Whisper" });
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
  Recording.instances = [];
  await act(async () => {
    renderer = create(<VoiceDictation onTranscript={onTranscript} />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("drops a cancelled transcript even after a new recording begins", async () => {
  const first = deferred<string>();
  transcribe.mockReturnValueOnce(first.promise);
  await act(async () => {
    button("Dictate locally into this draft").props.onClick();
  });
  await act(async () => {
    Recording.instances[0]!.stop();
  });
  expect(stop).toHaveBeenCalledOnce();
  await act(async () => {
    button("Cancel Dictation").props.onClick();
  });
  await act(async () => {
    button("Dictate locally into this draft").props.onClick();
  });
  await act(async () => {
    first.resolve("stale text");
  });
  expect(onTranscript).not.toHaveBeenCalled();
  expect(Recording.instances[1]!.state).toBe("recording");
  expect(renderer.root.findAllByType("button")[0]!.props.disabled).toBe(false);
});
it("stops a microphone granted after cancellation and ignores repeated starts", async () => {
  const media = deferred<{ getTracks: () => { stop: typeof stop }[] }>();
  getUserMedia.mockReturnValueOnce(media.promise);
  const click = button("Dictate locally into this draft").props.onClick;
  await act(async () => {
    click();
    click();
  });
  expect(getUserMedia).toHaveBeenCalledOnce();
  await act(async () => {
    button("Cancel Dictation").props.onClick();
  });
  await act(async () => {
    media.resolve({ getTracks: () => [{ stop }] });
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(Recording.instances).toHaveLength(0);
});
it("delivers a completed transcript once and never delivers it after unmount", async () => {
  transcribe.mockResolvedValueOnce("Draft text");
  await act(async () => {
    button("Dictate locally into this draft").props.onClick();
  });
  await act(async () => {
    Recording.instances[0]!.stop();
  });
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Draft text");
  const late = deferred<string>();
  transcribe.mockReturnValueOnce(late.promise);
  await act(async () => {
    button("Dictate locally into this draft").props.onClick();
  });
  await act(async () => {
    Recording.instances[1]!.stop();
  });
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    late.resolve("wrong session");
  });
  expect(onTranscript).toHaveBeenCalledTimes(1);
});
it("cancels a recording with Escape and only listens for Escape while recording", async () => {
  const listening = () =>
    vi
      .mocked(window.addEventListener)
      .mock.calls.filter(([type]) => type === "keydown")
      .map(([, handler]) => handler as (event: Partial<KeyboardEvent>) => void);
  expect(listening()).toHaveLength(0);
  await act(async () => {
    button("Dictate locally into this draft").props.onClick();
  });
  const [onKeyDown] = listening();
  expect(onKeyDown).toBeDefined();
  await act(async () => {
    onKeyDown!({ key: "a", preventDefault: vi.fn() });
  });
  expect(Recording.instances[0]!.state).toBe("recording");

  await act(async () => {
    onKeyDown!({ key: "Escape", preventDefault: vi.fn() });
  });
  expect(Recording.instances[0]!.state).toBe("inactive");
  expect(transcribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(vi.mocked(window.removeEventListener)).toHaveBeenCalledWith("keydown", onKeyDown);
  // Idle again: the mic is offered and the shortcut handler is gone.
  expect(button("Dictate locally into this draft")).toBeDefined();
});
