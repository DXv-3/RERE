import { afterEach, expect, it, vi } from "vite-plus/test";
import { createElevenAudio, pcm16Samples } from "./elevenAudio";
it("decodes streamed little-endian PCM including silence and full scale", () => {
  expect([...pcm16Samples(btoa(String.fromCharCode(0, 0, 0, 128, 255, 127)))]).toEqual([
    0,
    -1,
    32767 / 32768,
  ]);
  expect(() => pcm16Samples(btoa("x"))).toThrow("Invalid PCM");
});

afterEach(() => vi.unstubAllGlobals());
it("stops a microphone permission result that arrives after hangup", async () => {
  let resolve!: (stream: MediaStream) => void;
  const acquired = new Promise<MediaStream>((done) => {
    resolve = done;
  });
  const addModule = vi.fn();
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => {};
      close = close;
      audioWorklet = { addModule };
    },
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => acquired } });
  const audio = createElevenAudio();
  const pending = audio.start(vi.fn());
  await Promise.resolve();
  audio.dispose();
  const stop = vi.fn();
  resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await pending;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  expect(addModule).not.toHaveBeenCalled();
});
