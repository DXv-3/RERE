import { randomUUID } from "../lib/utils";
import { voiceUpdateChunks } from "@t3tools/client-runtime/voice-conversation/protocol";
export type VoicePhase = "connecting" | "connected" | "closing" | "ended" | "error";
export interface VoiceConnectionState {
  phase: VoicePhase;
  message: string;
  seconds: number;
  muted: boolean;
  /** Text actually submitted for ElevenLabs synthesis, including interrupted speech. */
  characters?: number;
}

/** One call owns its media devices. Closing the call never interrupts the coding agent. */
export function createLiveConnection(options: {
  negotiate: (sdp: string) => Promise<{ sessionId: string; sdp: string }>;
  onEvent: (event: unknown) => void;
  onExpired?: () => void;
  muted?: boolean;
  onState: (state: VoiceConnectionState) => void;
  audio: HTMLAudioElement;
  peer?: () => RTCPeerConnection;
  microphone?: () => Promise<MediaStream>;
}) {
  const listeners = new AbortController();
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let microphone: MediaStream | undefined;
  let state: VoiceConnectionState = {
    phase: "connecting",
    message: "Connecting…",
    seconds: 0,
    muted: options.muted ?? false,
  };
  let ended = false;
  let closing = false;
  let ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<VoiceConnectionState>) => {
    state = { ...state, ...patch };
    options.onState(state);
  };
  const cleanup = () => {
    ended = true;
    ready = false;
    clearTimeout(timer);
    microphone?.getTracks().forEach((track) => track.stop());
    listeners.abort();
    channel?.close();
    peer?.close();
    options.audio.pause();
    options.audio.srcObject = null;
  };
  const fail = (message: string) => {
    if (ended) return;
    cleanup();
    update({ phase: "error", message });
  };
  const send = (event: object) => {
    if (!ended && channel?.readyState === "open") channel.send(JSON.stringify(event));
  };
  const closeReady = () => {
    clearTimeout(timer);
    send({ type: "session.close" });
    timer = setTimeout(() => fail("Call ended without confirmed final usage."), 15000);
  };
  return {
    async start() {
      options.audio.muted = false;
      update({ phase: "connecting" });
      timer = setTimeout(() => fail("Voice connection timed out. Try again."), 45000);
      try {
        peer = options.peer?.() ?? new RTCPeerConnection();
        const connection = peer;
        connection.addEventListener(
          "track",
          ({ track }) => {
            options.audio.srcObject = new MediaStream([track]);
            void options.audio
              .play()
              .catch(() => update({ message: "Press Play to hear your agent." }));
          },
          { signal: listeners.signal },
        );
        connection.addEventListener(
          "connectionstatechange",
          () => {
            if (
              connection.connectionState === "failed" ||
              connection.connectionState === "disconnected"
            )
              fail("Voice disconnected. Your agent’s work continues. Reconnect when ready.");
          },
          { signal: listeners.signal },
        );
        microphone = await (options.microphone?.() ??
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          }));
        if (ended || closing) {
          cleanup();
          update({ phase: "ended", message: "Call ended." });
          return;
        }
        microphone.getAudioTracks().forEach((track) => {
          track.enabled = !(options.muted ?? false);
          connection.addTrack(track, microphone!);
        });
        channel = connection.createDataChannel("oai-events");
        channel.addEventListener(
          "close",
          () =>
            fail("Voice disconnected before final usage was confirmed. Your agent keeps working."),
          { signal: listeners.signal },
        );
        channel.addEventListener(
          "message",
          ({ data }) => {
            if (ended) return;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data);
            } catch {
              return;
            }
            if (!event || typeof event !== "object") return;
            if (event.type === "session.started") {
              ready = true;
              clearTimeout(timer);
              if (closing) closeReady();
              else update({ phase: "connected", message: "Listening — speak naturally." });
            } else if (event.type === "session.closed") {
              const usage = event.usage as { seconds?: number } | undefined;
              cleanup();
              update({
                phase: "ended",
                message: "Call ended. Your agent’s work continues.",
                seconds: usage?.seconds ?? state.seconds,
              });
              if (!closing && event.reason === "expired") options.onExpired?.();
            } else if (event.type === "session.usage.updated") {
              const usage = event.usage as { seconds?: number } | undefined;
              if (typeof usage?.seconds === "number") update({ seconds: usage.seconds });
            } else if (event.type === "error") {
              update({
                message:
                  "The voice service rejected an update. Check the conversation for the latest work.",
              });
            }
            if (!closing) options.onEvent(event);
          },
          { signal: listeners.signal },
        );
        await connection.setLocalDescription(await connection.createOffer());
        if (connection.iceGatheringState !== "complete")
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              connection.removeEventListener("icegatheringstatechange", check);
              reject(new Error("Could not establish an audio connection."));
            }, 10000);
            function check() {
              if (connection.iceGatheringState === "complete") {
                clearTimeout(timeout);
                connection.removeEventListener("icegatheringstatechange", check);
                resolve();
              }
            }
            connection.addEventListener("icegatheringstatechange", check);
            check();
          });
        if (ended || closing) {
          cleanup();
          update({ phase: "ended", message: "Call ended." });
          return;
        }
        const offer = connection.localDescription?.sdp;
        if (!offer) throw new Error("Could not create an audio connection.");
        const answer = await options.negotiate(offer);
        if (ended) return;
        await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp });
        // HTTP already starts GPT-Live. Wait for session.started; never send session.start.
      } catch (error) {
        fail(error instanceof Error ? error.message : "Could not start voice.");
      }
    },
    mute(muted: boolean) {
      microphone?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      update({ muted });
    },
    append(text: string, speak = false, delegationId: string | null = null) {
      if (!ready || ended || closing) return;
      for (const content of voiceUpdateChunks(text))
        send({
          type: speak ? "session.commentary.append" : "session.thinking.append",
          event_id: randomUUID(),
          delegation_id: delegationId,
          content,
        });
    },
    end() {
      if (ended || closing) return;
      closing = true;
      options.audio.muted = true;
      microphone?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      update({ phase: "closing", message: "Ending call…", muted: true });
      if (ready) closeReady();
    },
    dispose: cleanup,
  };
}
