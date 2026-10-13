import { createElevenAudio, type ElevenAudio } from "./elevenAudio";
import type { VoiceConnectionState } from "./liveConnection";
import { randomUUID } from "../lib/utils";

const ELEVEN_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " Code is available in the conversation. ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link in the conversation")
    .replace(/[#*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400);
}

/** Scribe handles listening; completed utterances go to the existing agent, never a second LLM. */
export function createElevenConnection(options: {
  token: (purpose: "realtime_scribe" | "tts_websocket") => Promise<string>;
  onUtterance: (id: string, text: string) => void;
  onTranscript: (role: "User" | "Voice", text: string) => void;
  onState: (state: VoiceConnectionState) => void;
  onExpired?: () => void;
  muted?: boolean;
  audio?: () => ElevenAudio;
  socket?: (url: string) => WebSocket;
}) {
  let state: VoiceConnectionState = {
    phase: "connecting",
    message: "Connecting ElevenLabs…",
    seconds: 0,
    muted: options.muted ?? false,
    characters: 0,
  };
  let closed = false;
  let started = false;
  let audio: ElevenAudio | undefined;
  let scribe: WebSocket | undefined;
  let speech: WebSocket | undefined;
  let userSpeaking = false;
  let speaking = false;
  let generation = 0;
  let connectedAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let speechTimeout: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];
  const socket = options.socket ?? ((url: string) => new WebSocket(url));
  const update = (patch: Partial<VoiceConnectionState>) => {
    state = { ...state, ...patch };
    options.onState(state);
  };
  const interruptSpeech = () => {
    generation++;
    clearTimeout(speechTimeout);
    queue.length = 0;
    speaking = false;
    speech?.close();
    speech = undefined;
    audio?.interrupt();
  };
  const cleanup = () => {
    closed = true;
    clearInterval(timer);
    clearTimeout(timeout);
    interruptSpeech();
    scribe?.close();
    audio?.dispose();
  };
  const fail = (message: string) => {
    if (closed) return;
    cleanup();
    update({ phase: "error", message });
  };
  const speakNext = async () => {
    if (closed || state.phase !== "connected" || speaking || userSpeaking || !queue.length) return;
    speaking = true;
    const text = queue.shift()!;
    const version = generation;
    const current = () => !closed && version === generation;
    speechTimeout = setTimeout(() => {
      if (current()) fail("Speech timed out. Resume the call to try again.");
    }, 45000);
    try {
      const token = await options.token("tts_websocket");
      if (!current()) return;
      // V4 Turbo is served by the Text to Dialogue socket, not the older TTS endpoint.
      const url = new URL("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input");
      url.searchParams.set("model_id", "eleven_v4_turbo");
      url.searchParams.set("output_format", "pcm_24000");
      // Send the one-use token in the first frame so it is not part of a TTS URL.
      const ws = socket(url.href);
      speech = ws;
      let complete = false;
      let transcriptSent = false;
      ws.onopen = () => {
        if (!current()) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ voices: [ELEVEN_VOICE_ID], single_use_token: token }));
        ws.send(JSON.stringify({ inputs: [{ text, voice_id: ELEVEN_VOICE_ID }] }));
        ws.send(JSON.stringify({ close_socket: true }));
        update({ characters: (state.characters ?? 0) + Array.from(text).length });
      };
      ws.onmessage = (message) => {
        if (!current()) return;
        try {
          const event = JSON.parse(String(message.data));
          if (event.error || event.error_code) {
            fail("ElevenLabs speech failed. Check V4 Turbo access, your key and billing.");
            return;
          }
          if (typeof event.audio === "string" && event.audio) {
            audio?.play(event.audio);
            if (!transcriptSent) {
              options.onTranscript("Voice", text);
              transcriptSent = true;
            }
          }
          if (event.is_final === true) {
            complete = true;
            ws.close();
          }
        } catch {
          fail("Could not play ElevenLabs audio. Check the thread for the agent's reply.");
        }
      };
      ws.onerror = () => {
        if (current()) fail("ElevenLabs speech disconnected. Resume to try again.");
      };
      ws.onclose = () => {
        if (!current()) return;
        clearTimeout(speechTimeout);
        speech = undefined;
        speaking = false;
        if (!complete) {
          fail("ElevenLabs ended speech unexpectedly. Resume to try again.");
          return;
        }
        void speakNext();
      };
    } catch {
      if (current())
        fail("Could not authorize ElevenLabs speech. Check the voice key and connection.");
    }
  };
  return {
    async start() {
      if (started || closed) return;
      started = true;
      update({ phase: "connecting" });
      timeout = setTimeout(
        () => fail("Voice connection timed out. Check microphone permission and try again."),
        45000,
      );
      try {
        audio = (options.audio ?? createElevenAudio)();
        audio.mute(state.muted);
        await audio.start((chunk) => {
          if (closed || state.phase !== "connected" || scribe?.readyState !== 1) return;
          if (scribe.bufferedAmount > 256000) {
            fail("Voice upload is falling behind. Check your connection and resume.");
            return;
          }
          scribe.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: chunk,
              commit: false,
              sample_rate: 16000,
            }),
          );
        });
        if (closed) return;
        const token = await options.token("realtime_scribe");
        if (closed) return;
        const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
        url.searchParams.set("token", token);
        url.searchParams.set("model_id", "scribe_v2_realtime");
        url.searchParams.set("audio_format", "pcm_16000");
        url.searchParams.set("commit_strategy", "vad");
        url.searchParams.set("vad_silence_threshold_secs", "1.2");
        const ws = socket(url.href);
        scribe = ws;
        ws.onmessage = (message) => {
          if (closed) return;
          try {
            const event = JSON.parse(String(message.data));
            if (event.message_type === "session_started" && state.phase === "connecting") {
              clearTimeout(timeout);
              connectedAt = Date.now();
              update({ phase: "connected", message: "Listening. Your agent will reply here." });
              timer = setInterval(
                () => update({ seconds: Math.floor((Date.now() - connectedAt) / 1000) }),
                1000,
              );
            } else if (
              event.message_type === "partial_transcript" &&
              typeof event.text === "string" &&
              event.text.trim()
            ) {
              if (!userSpeaking) interruptSpeech();
              userSpeaking = true;
            } else if (
              event.message_type === "committed_transcript" &&
              typeof event.text === "string"
            ) {
              // Timestamped transcripts and edits are supplementary, not new user turns.
              const text = event.text.trim().slice(0, 4000);
              if (text && !userSpeaking) interruptSpeech();
              userSpeaking = false;
              if (text) {
                options.onTranscript("User", text);
                options.onUtterance(randomUUID(), text);
              }
              void speakNext();
            } else if (event.message_type === "session_time_limit_exceeded") {
              cleanup();
              update({ phase: "ended", message: "Renewing the voice connection…" });
              options.onExpired?.();
            } else if (event.error || event.message_type === "error") {
              fail("ElevenLabs listening failed. Check the key, available credits and connection.");
            }
          } catch {
            fail("Could not read the voice response. Resume to try again.");
          }
        };
        ws.onerror = () => fail("ElevenLabs listening disconnected. Resume to try again.");
        ws.onclose = () => {
          if (!closed) fail("Voice disconnected. Resume the call when ready.");
        };
      } catch {
        fail("Could not start ElevenLabs. Check microphone permission, API key and connection.");
      }
    },
    append(text: string, speak = false, _delegationId?: string) {
      if (closed || !speak || state.phase !== "connected") return;
      const clean = spokenText(text);
      if (!clean) return;
      if (queue.length >= 8) {
        fail("Too many spoken updates. Check the thread, then resume the call.");
        return;
      }
      queue.push(clean);
      void speakNext();
    },
    mute(muted: boolean) {
      if (!closed) {
        audio?.mute(muted);
        update({ muted });
      }
    },
    resumeAudio: async () => {
      if (!closed) await audio?.resume();
    },
    end() {
      if (!closed) {
        cleanup();
        update({ phase: "ended", message: "Call ended. Your agent can keep working." });
      }
    },
    dispose: cleanup,
  };
}
