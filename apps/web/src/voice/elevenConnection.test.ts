import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createElevenConnection, spokenText } from "./elevenConnection";
import type { VoiceConnectionState } from "./liveConnection";

function fixture(
  token = vi.fn(async (_purpose: string) => "ephemeral"),
  start = vi.fn(async (_onChunk: (chunk: string) => void) => {}),
) {
  const audio = {
    start,
    play: vi.fn(),
    interrupt: vi.fn(),
    mute: vi.fn(),
    resume: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const sockets: { url: string; ws: WebSocket }[] = [];
  const states: VoiceConnectionState[] = [];
  const onUtterance = vi.fn();
  const onTranscript = vi.fn();
  const onExpired = vi.fn();
  const connection = createElevenConnection({
    token,
    audio: () => audio,
    socket: (url) => {
      const ws = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn(),
        close: vi.fn(),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } as unknown as WebSocket;
      sockets.push({ url, ws });
      return ws;
    },
    onUtterance,
    onTranscript,
    onExpired,
    onState: (s) => states.push(s),
  });
  const event = (value: object, index = 0) =>
    sockets[index]!.ws.onmessage?.call(sockets[index]!.ws, {
      data: JSON.stringify(value),
    } as MessageEvent);
  return { connection, sockets, audio, token, states, event, onUtterance, onTranscript, onExpired };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("ElevenLabs agent conversations", () => {
  it("streams PCM with explicit VAD commit semantics only after Scribe is ready", async () => {
    const start = vi.fn(async (_onChunk: (chunk: string) => void) => {});
    const f = fixture(undefined, start);
    await f.connection.start();
    const onChunk = start.mock.calls[0]![0];
    onChunk("before-ready");
    expect(f.sockets[0]!.ws.send).not.toHaveBeenCalled();
    f.event({ message_type: "session_started" });
    onChunk("PCM");
    expect(f.sockets[0]!.ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "PCM",
        commit: false,
        sample_rate: 16000,
      }),
    );
    f.connection.end();
    onChunk("after-hangup");
    expect(f.sockets[0]!.ws.send).toHaveBeenCalledTimes(1);
  });
  it("resumes queued replies after an empty final transcript without dispatching work", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.event({ message_type: "partial_transcript", text: "noise" });
    f.connection.append("Your result is ready.", true);
    await flush();
    expect(f.sockets).toHaveLength(1);
    f.event({ message_type: "committed_transcript", text: " " });
    await flush();
    expect(f.sockets).toHaveLength(2);
    expect(f.onUtterance).not.toHaveBeenCalled();
    expect(f.onTranscript).not.toHaveBeenCalled();
    f.connection.dispose();
  });
  it("submits only committed speech, ignores supplementary transcripts and keeps repeated requests distinct", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.event({ message_type: "partial_transcript", text: "do it" });
    expect(f.onUtterance).not.toHaveBeenCalled();
    f.event({ message_type: "committed_transcript", text: "do it" });
    f.event({ message_type: "committed_transcript_with_timestamps", text: "do it" });
    f.event({ message_type: "edited_transcript", text: "do it" });
    expect(f.onUtterance).toHaveBeenCalledTimes(1);
    f.event({ message_type: "partial_transcript", text: "do it" });
    f.event({ message_type: "committed_transcript", text: "do it" });
    expect(f.onUtterance).toHaveBeenCalledTimes(2);
    expect(f.onUtterance.mock.calls[0]![0]).not.toBe(f.onUtterance.mock.calls[1]![0]);
    expect(f.sockets[0]!.url).toContain("commit_strategy=vad");
    f.connection.dispose();
  });
  it("streams V4 Turbo PCM using a one-use token and interrupts playback without dispatching work", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.connection.append("The work is ready.", true);
    await flush();
    const tts = f.sockets[1]!.ws;
    expect(f.sockets[1]!.url).toContain("model_id=eleven_v4_turbo");
    expect(f.sockets[1]!.url).not.toContain("ephemeral");
    tts.onopen?.call(tts, new Event("open"));
    expect(tts.send).toHaveBeenCalledWith(
      expect.stringContaining('"single_use_token":"ephemeral"'),
    );
    f.event({ audio: "PCM" }, 1);
    expect(f.audio.play).toHaveBeenCalledWith("PCM");
    f.event({ message_type: "partial_transcript", text: "wait" });
    expect(tts.close).toHaveBeenCalled();
    expect(f.audio.interrupt).toHaveBeenCalled();
    f.audio.play.mockClear();
    f.event({ audio: "late" }, 1);
    expect(f.audio.play).not.toHaveBeenCalled();
    expect(f.onUtterance).not.toHaveBeenCalled();
    f.connection.dispose();
  });
  it("does not reopen speech if interrupted while its token is pending", async () => {
    let resolve!: (token: string) => void;
    const token = vi.fn(async (purpose: string) =>
      purpose === "realtime_scribe"
        ? "stt"
        : new Promise<string>((done) => {
            resolve = done;
          }),
    );
    const f = fixture(token);
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.connection.append("Result", true);
    f.event({ message_type: "partial_transcript", text: "stop talking" });
    resolve("late");
    await flush();
    expect(f.sockets).toHaveLength(1);
    f.connection.dispose();
  });
  it("releases capture and ignores late transcripts on hangup", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.connection.mute(true);
    expect(f.audio.mute).toHaveBeenLastCalledWith(true);
    f.connection.end();
    f.event({ message_type: "committed_transcript", text: "late" });
    expect(f.audio.dispose).toHaveBeenCalled();
    expect(f.sockets[0]!.ws.close).toHaveBeenCalled();
    expect(f.onUtterance).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.phase).toBe("ended");
  });
  it("never connects after hangup during microphone acquisition", async () => {
    let resolve!: () => void;
    const f = fixture(
      undefined,
      vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    );
    const pending = f.connection.start();
    f.connection.end();
    resolve();
    await pending;
    expect(f.token).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
  });
  it("fails closed without retrying provider errors", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.event({ message_type: "quota_exceeded", error: "private provider detail" });
    expect(f.states.at(-1)?.phase).toBe("error");
    expect(f.states.at(-1)?.message).not.toContain("private");
    expect(f.audio.dispose).toHaveBeenCalled();
    expect(f.token).toHaveBeenCalledTimes(1);
  });
  it("renews only a provider-confirmed session expiry", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.event({ message_type: "session_time_limit_exceeded" });
    expect(f.onExpired).toHaveBeenCalledTimes(1);
    const other = fixture();
    await other.connection.start();
    other.connection.end();
    other.event({ message_type: "session_time_limit_exceeded" });
    expect(other.onExpired).not.toHaveBeenCalled();
  });
  it("bounds startup and does not leave the microphone running", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.connection.start();
    await vi.advanceTimersByTimeAsync(45000);
    expect(f.states.at(-1)?.phase).toBe("error");
    expect(f.audio.dispose).toHaveBeenCalled();
  });
  it("queues speech in order but never reads silent context updates aloud", async () => {
    const f = fixture();
    await f.connection.start();
    f.event({ message_type: "session_started" });
    f.connection.append("Private context");
    f.connection.append("First", true);
    f.connection.append("Second", true);
    await flush();
    expect(f.sockets).toHaveLength(2);
    const tts = f.sockets[1]!.ws;
    tts.onopen?.call(tts, new Event("open"));
    f.event({ audio: "PCM" }, 1);
    f.event({ is_final: true }, 1);
    tts.onclose?.call(tts, new Event("close") as CloseEvent);
    await flush();
    expect(f.sockets).toHaveLength(3);
    expect(f.onTranscript).toHaveBeenCalledWith("Voice", "First");
    expect(f.onTranscript).not.toHaveBeenCalledWith("Voice", "Private context");
    f.connection.dispose();
  });
  it("keeps code blocks and raw URLs out of spoken results", () => {
    expect(spokenText("Done. ```js\nsecret code\n``` See [report](https://example.com).")).toBe(
      "Done. Code is available in the conversation. See report.",
    );
  });
});
