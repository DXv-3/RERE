import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createLiveConnection, type VoiceConnectionState } from "./liveConnection";
function fixture(
  negotiate = vi.fn(async (_sdp: string) => ({ sessionId: "live_1", sdp: "answer" })),
  muted = false,
  microphone?: () => Promise<MediaStream>,
) {
  const track = { stop: vi.fn(), enabled: true };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const channel = Object.assign(new EventTarget(), {
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
    onclose: null,
    onmessage: null,
  });
  const peer = Object.assign(new EventTarget(), {
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ sdp: "offer" }),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    localDescription: { sdp: "offer" },
    iceGatheringState: "complete",
    close: vi.fn(),
  });
  const audio = { pause: vi.fn(), play: vi.fn(async () => {}), srcObject: null };
  const states: VoiceConnectionState[] = [];
  const onEvent = vi.fn();
  const onExpired = vi.fn();
  const live = createLiveConnection({
    negotiate,
    onState: (s) => states.push(s),
    onEvent,
    onExpired,
    audio: audio as unknown as HTMLAudioElement,
    peer: () => peer as unknown as RTCPeerConnection,
    microphone: microphone ?? (async () => stream),
    muted,
  });
  const event = (value: object) =>
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  return { live, event, peer, channel, track, stream, states, onEvent, onExpired, negotiate };
}
afterEach(() => vi.useRealTimers());
describe("live voice connection", () => {
  it("waits for startup, negotiates once, and does not send session.start", async () => {
    const f = fixture();
    await f.live.start();
    expect(f.states.at(-1)?.phase).toBe("connecting");
    expect(f.negotiate).toHaveBeenCalledTimes(1);
    expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer" });
    f.event({ type: "session.started" });
    expect(f.states.at(-1)?.phase).toBe("connected");
    expect(f.channel.send).not.toHaveBeenCalled();
    f.live.dispose();
  });
  it("mutes capture, closes gracefully, and releases all media after final usage", async () => {
    const f = fixture();
    await f.live.start();
    f.event({ type: "session.started" });
    f.live.mute(true);
    expect(f.track.enabled).toBe(false);
    f.live.end();
    expect(f.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.close" }));
    expect(f.peer.close).not.toHaveBeenCalled();
    f.event({ type: "session.closed", usage: { seconds: 42 } });
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.peer.close).toHaveBeenCalled();
    expect(f.states.at(-1)).toMatchObject({ phase: "ended", seconds: 42 });
  });
  it("does not send work or updates after ending, even while waiting for finalization", async () => {
    const f = fixture();
    await f.live.start();
    f.event({ type: "session.started" });
    f.live.end();
    f.onEvent.mockClear();
    f.event({ type: "session.delegation.created", delegation: { id: "late", target: "client" } });
    f.live.append("Late result", true);
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    f.live.dispose();
  });
  it("releases the microphone when negotiation fails without retrying", async () => {
    const negotiate = vi.fn(async () => {
      throw new Error("No access");
    });
    const f = fixture(negotiate);
    await f.live.start();
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.states.at(-1)?.phase).toBe("error");
  });
  it("bounds graceful close when the provider never acknowledges", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.live.start();
    f.event({ type: "session.started" });
    f.live.end();
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.states.at(-1)?.message).toContain("without confirmed");
  });
  it("requests renewal only for a confirmed natural expiry, never a hangup", async () => {
    const f = fixture();
    await f.live.start();
    f.event({ type: "session.started" });
    f.event({ type: "session.closed", reason: "expired", usage: { seconds: 3600 } });
    expect(f.onExpired).toHaveBeenCalledTimes(1);
    const stopped = fixture();
    await stopped.live.start();
    stopped.event({ type: "session.started" });
    stopped.live.end();
    stopped.event({ type: "session.closed", reason: "expired" });
    expect(stopped.onExpired).not.toHaveBeenCalled();
  });
  it("keeps capture muted before transmitting on a renewed session", async () => {
    const f = fixture(undefined, true);
    await f.live.start();
    expect(f.track.enabled).toBe(false);
    expect(f.states.at(-1)?.muted).toBe(true);
    f.live.dispose();
  });
  it("releases late microphone permission after disposal without creating a session", async () => {
    let allow!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      allow = resolve;
    });
    const f = fixture(undefined, false, () => permission);
    const starting = f.live.start();
    f.live.dispose();
    allow(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalled();
    expect(f.negotiate).not.toHaveBeenCalled();
  });
  it("honors hangup while session creation is in flight", async () => {
    let answer!: (value: { sessionId: string; sdp: string }) => void;
    let entering!: () => void;
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const negotiated = new Promise<{ sessionId: string; sdp: string }>((resolve) => {
      answer = resolve;
    });
    const f = fixture(
      vi.fn(async () => {
        entering();
        return negotiated;
      }),
    );
    const starting = f.live.start();
    await entered;
    f.live.end();
    answer({ sessionId: "live", sdp: "answer" });
    await starting;
    f.event({ type: "session.started" });
    expect(f.channel.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.close" }));
    expect(f.track.enabled).toBe(false);
    f.event({ type: "session.closed", reason: "close_requested" });
    expect(f.states.at(-1)?.phase).toBe("ended");
  });
});
