import { createElevenConnection } from "./elevenConnection";
import { Popover, PopoverTrigger, PopoverPopup } from "../components/ui/popover";
import { createVoiceWorkObserver } from "@t3tools/client-runtime/voice-conversation/work-updates";
import { OPEN_VOICE_CONVERSATION, type VoiceTarget } from "./voiceActions";
import { randomUUID } from "../lib/utils";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Phone, PhoneOff, Mic, MicOff, X } from "lucide-react";
import { createVoiceConversationAtoms } from "@t3tools/client-runtime/state/voice-conversation";
import { createVoiceConversationProtocol } from "@t3tools/client-runtime/voice-conversation/protocol";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { createLiveConnection, type VoiceConnectionState } from "./liveConnection";
import "./voiceConversation.css";

const commands = createVoiceConversationAtoms(connectionAtomRuntime);
type Target = VoiceTarget;

/** Mounted in the shell so changing tabs never ends a call or changes its recipient. */
export function VoiceConversationControl({ target }: { target: Target | null }) {
  const [callTarget, setCallTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const [configuration, setConfiguration] = useState<{
    environmentId: string;
    configured: boolean;
    elevenLabsConfigured: boolean;
  } | null>(null);
  const [voiceProvider, setVoiceProvider] = useState<"elevenlabs" | "openai">("elevenlabs");
  const totalCharacters = useRef(0);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoResume, setAutoResume] = useState(false);
  const totalSeconds = useRef(0);
  const [transcript, setTranscript] = useState("");
  const [state, setState] = useState<VoiceConnectionState>({
    phase: "ended",
    message: "",
    seconds: 0,
    muted: false,
  });
  const selected = callTarget ?? target;
  const configured =
    configuration && configuration.environmentId === selected?.environmentId
      ? voiceProvider === "elevenlabs"
        ? configuration.elevenLabsConfigured
        : configuration.configured
      : null;
  const detail = useEnvironmentThread(selected?.environmentId ?? null, selected?.threadId ?? null);
  const projection = Option.getOrNull(detail.data);
  const latest = useRef(projection);
  useEffect(() => {
    latest.current = projection;
  }, [projection]);
  const connection = useRef<
    ReturnType<typeof createLiveConnection> | ReturnType<typeof createElevenConnection> | null
  >(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const observeWork = useRef<ReturnType<typeof createVoiceWorkObserver> | null>(null);
  const session = useRef("");
  const savedDialogue = useRef({ recipient: "", text: "" });
  const status = useAtomCommand(commands.status, { reportFailure: false });
  const configure = useAtomCommand(commands.configure, {
    reportFailure: false,
    reportDefect: false,
  });
  const token = useAtomCommand(commands.token, { reportFailure: false, reportDefect: false });
  const create = useAtomCommand(commands.create, { reportFailure: false });
  const dispatch = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const active =
    state.phase === "connected" || state.phase === "connecting" || state.phase === "closing";
  useEffect(
    () => () => {
      session.current = "";
      connection.current?.dispose();
    },
    [],
  );
  useEffect(() => {
    const show = (event: Event) => {
      const requested = (event as CustomEvent<VoiceTarget>).detail;
      if (!active) {
        setCallTarget(requested);
        setError("");
      } else if (
        requested.threadId !== callTarget?.threadId ||
        requested.environmentId !== callTarget?.environmentId
      )
        setError("End this call before calling another agent.");
      setOpen(true);
    };
    window.addEventListener(OPEN_VOICE_CONVERSATION, show);
    return () => window.removeEventListener(OPEN_VOICE_CONVERSATION, show);
  }, [active, callTarget]);
  const selectedEnvironmentId = selected?.environmentId;
  useEffect(() => {
    if (!open || !selectedEnvironmentId) return;
    let cancelled = false;
    void status({ environmentId: selectedEnvironmentId, input: {} }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success")
        setConfiguration({
          environmentId: selectedEnvironmentId,
          configured: result.value.configured,
          elevenLabsConfigured: result.value.elevenLabsConfigured,
        });
      else setError("Voice is unavailable on this machine. Update its server or reconnect.");
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedEnvironmentId, status]);

  useEffect(() => {
    if (state.phase !== "connected" || !projection) return;
    for (const update of observeWork.current?.(projection) ?? []) {
      connection.current?.append(update.text, update.speak);
    }
  }, [projection, state.phase]);

  const start = async () => {
    if (!selected || !projection || !audio.current || active) return;
    const recipient = selected;
    const recipientKey = `${recipient.environmentId}/${recipient.threadId}/${voiceProvider}`;
    if (savedDialogue.current.recipient !== recipientKey) {
      totalSeconds.current = 0;
      totalCharacters.current = 0;
    }
    const priorDialogue =
      savedDialogue.current.recipient === recipientKey ? savedDialogue.current.text : "";
    setCallTarget(recipient);
    setError("");
    setTranscript("");
    const generation = randomUUID();
    session.current = generation;
    if (!autoResume)
      observeWork.current = createVoiceWorkObserver(projection, {
        speakProgress: voiceProvider === "elevenlabs",
      });
    const submit = (delegationId: string, context: string) => {
      const current = latest.current;
      if (!current || session.current !== generation) return;
      const id = `voice:${generation}:${delegationId}`;
      void dispatch({
        environmentId: recipient.environmentId,
        input: {
          threadId: recipient.threadId,
          commandId: CommandId.make(id),
          message: {
            messageId: MessageId.make(id),
            role: "user",
            attachments: [],
            text: `Live voice conversation. Carry out the latest request or correction below using your existing tools and permissions. Earlier dialogue is context; do not repeat actions already done. Voice transcripts may contain mistakes; clarify ambiguity. Respond conversationally with brief, speakable progress and final results. Keep code and long lists in the thread; speak a short summary. Answer casual questions naturally as well as doing project work.\n\n${context}`,
          },
          runtimeMode: current.thread.runtimeMode,
          interactionMode: current.thread.interactionMode,
          dispatchMode: "auto",
        },
      }).then((result) => {
        if (session.current !== generation) return;
        connection.current?.append(
          result._tag === "Success"
            ? "The request was accepted by the agent. It may be running or queued. This is not a completed result."
            : "I could not confirm that the request started. Please check the thread before trying again.",
          result._tag !== "Success",
          delegationId,
        );
      });
    };
    const protocol = createVoiceConversationProtocol(submit);
    const previousSeconds = totalSeconds.current;
    const previousCharacters = totalCharacters.current;
    const onState = (next: VoiceConnectionState) => {
      if (session.current !== generation) return;
      totalSeconds.current = previousSeconds + next.seconds;
      totalCharacters.current = previousCharacters + (next.characters ?? 0);
      setState({ ...next, seconds: totalSeconds.current, characters: totalCharacters.current });
    };
    const onExpired = () => {
      if (session.current === generation) setAutoResume(true);
    };
    let elevenTranscript = priorDialogue;
    const live =
      voiceProvider === "elevenlabs"
        ? createElevenConnection({
            muted: autoResume && state.muted,
            onState,
            onExpired,
            token: async (purpose) => {
              const result = await token({
                environmentId: recipient.environmentId,
                input: { purpose },
              });
              if (result._tag === "Failure") throw new Error("Could not authorize ElevenLabs.");
              return result.value.token;
            },
            onUtterance: (id, text) => submit(id, `New user speech:\n${text}`),
            onTranscript: (role, text) => {
              if (session.current !== generation) return;
              elevenTranscript = `${elevenTranscript}\n${role}: ${text}`.slice(-8000);
              setTranscript(elevenTranscript);
              savedDialogue.current = { recipient: recipientKey, text: elevenTranscript };
            },
          })
        : createLiveConnection({
            muted: autoResume && state.muted,
            onExpired: () => {
              if (session.current === generation) setAutoResume(true);
            },
            audio: audio.current,
            negotiate: async (sdp) => {
              const result = await create({
                environmentId: recipient.environmentId,
                input: { sdp, agentName: recipient.name },
              });
              if (result._tag === "Failure")
                throw new Error(
                  "Could not connect GPT-Live. Check the API key, model access, and billing.",
                );
              return result.value;
            },
            onState,
            onEvent: (event) => {
              if (session.current !== generation) return;
              protocol.receive(event);
              setTranscript(protocol.transcript());
              savedDialogue.current = {
                recipient: recipientKey,
                text: (priorDialogue + "\n" + protocol.transcript()).slice(-8000),
              };
              if (
                event &&
                typeof event === "object" &&
                "type" in event &&
                event.type === "session.started"
              ) {
                const recent = latest.current?.messages
                  .slice(-4)
                  .map((m) => `${m.role}: ${m.text.slice(0, 600)}`)
                  .join("\n");
                if (priorDialogue)
                  live.append(
                    `Previous voice conversation, context only. Do not repeat any actions: ${priorDialogue.slice(-3000)}`,
                  );
                live.append(
                  `Current agent: ${recipient.name}. Recent work, for context only:\n${recent ?? "No previous messages."}`,
                );
              }
            },
          });
    connection.current?.dispose();
    connection.current = live;
    await live.start();
  };
  const resumeExpired = useEffectEvent(() => {
    void start();
  });
  useEffect(() => {
    if (!autoResume || active) return;
    setAutoResume(false);
    resumeExpired();
  }, [autoResume, active]);
  const save = async (value: string) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    const result = await configure({
      environmentId: selected.environmentId,
      input: { apiKey: value, provider: voiceProvider },
    });
    setKey("");
    setBusy(false);
    if (result._tag === "Success")
      setConfiguration({
        environmentId: selected.environmentId,
        configured: result.value.configured,
        elevenLabsConfigured: result.value.elevenLabsConfigured,
      });
    else setError("Could not save the key. An administrator must configure voice on this machine.");
  };
  const stopWork = async () => {
    if (!selected) return;
    setBusy(true);
    const result = await interrupt({
      environmentId: selected.environmentId,
      input: { threadId: selected.threadId },
    });
    setBusy(false);
    connection.current?.append(
      result._tag === "Success"
        ? "A stop request was accepted. Wait for the run status before confirming it stopped."
        : "Could not confirm that work stopped. Check the agent conversation.",
      true,
    );
  };
  if (!target && !callTarget) return null;
  return (
    <div data-voice-conversation="">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={active ? `Call with ${selected?.name}` : "Talk to your agent"}
            />
          }
        >
          <Phone size={15} />
          {active ? "In call" : "Talk"}
        </PopoverTrigger>
        <PopoverPopup width="lg" align="end">
          <section data-voice-conversation-panel="" aria-label="Agent voice conversation">
            <header>
              <strong>{selected?.name}</strong>
              <button
                type="button"
                aria-label="Minimize voice panel"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <label htmlFor="voice-provider">Voice provider</label>
            <select
              id="voice-provider"
              value={voiceProvider}
              disabled={active || busy}
              onChange={(event) => {
                setVoiceProvider(event.target.value as "elevenlabs" | "openai");
                setKey("");
                setError("");
                setTranscript("");
                totalSeconds.current = 0;
                totalCharacters.current = 0;
                setState({ phase: "ended", message: "", seconds: 0, muted: false });
              }}
            >
              <option value="elevenlabs">ElevenLabs V4 Turbo</option>
              <option value="openai">GPT-Live-1</option>
            </select>
            <p>
              Talk while your agent works. Speaking interrupts playback; stopping work is a separate
              action. Audio is sent to {voiceProvider === "elevenlabs" ? "ElevenLabs" : "OpenAI"}.
            </p>
            <p data-voice-price="">
              {voiceProvider === "elevenlabs"
                ? "V4 Turbo speech + Scribe realtime listening + your existing agent. Standard rates: $0.04/1,000 spoken characters and $0.39/hour listening; plan pricing and promotions vary."
                : "GPT-Live-1 · $0.05/min + agent usage."}{" "}
              Muting keeps the connection open and billed.
            </p>
            {error && <p role="alert">{error}</p>}
            {configured === false && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(key);
                }}
              >
                <label htmlFor="voice-api-key">
                  {voiceProvider === "elevenlabs" ? "ElevenLabs" : "OpenAI"} API key
                </label>
                <input
                  id="voice-api-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Saved securely on this machine"
                />
                <button type="submit" disabled={busy || !key.trim()}>
                  Connect voice
                </button>
              </form>
            )}
            <p role="status">{state.message}</p>
            {state.seconds > 0 && (
              <p data-voice-price="">
                {Math.floor(state.seconds / 60)}:
                {String(Math.floor(state.seconds % 60)).padStart(2, "0")}
                {voiceProvider === "elevenlabs"
                  ? ` · ${(state.characters ?? 0).toLocaleString()} characters sent for speech`
                  : ` · Voice approximately $${((state.seconds / 60) * 0.05).toFixed(2)}`}
              </p>
            )}
            <div data-voice-conversation-actions="">
              {!active && configured && (
                <button
                  type="button"
                  disabled={!projection || detail.status !== "live"}
                  onClick={() => void start()}
                >
                  <Phone size={15} />
                  {state.seconds ? "Resume conversation" : "Start conversation"}
                </button>
              )}
              {active && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const call = connection.current;
                      const playback =
                        call && "resumeAudio" in call ? call.resumeAudio() : audio.current?.play();
                      void playback?.catch(() =>
                        setError(
                          "Audio playback is blocked. Check your browser’s sound permission.",
                        ),
                      );
                    }}
                  >
                    Play audio
                  </button>
                  <button
                    type="button"
                    disabled={state.phase !== "connected"}
                    onClick={() => connection.current?.mute(!state.muted)}
                  >
                    {state.muted ? <MicOff size={15} /> : <Mic size={15} />}
                    {state.muted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    type="button"
                    disabled={state.phase === "closing"}
                    onClick={() => connection.current?.end()}
                  >
                    <PhoneOff size={15} />
                    End call
                  </button>
                  <button type="button" disabled={busy} onClick={() => void stopWork()}>
                    Stop agent work
                  </button>
                </>
              )}
            </div>
            {transcript && (
              <details>
                <summary>Conversation transcript</summary>
                <pre>{transcript}</pre>
              </details>
            )}
            {configured && !active && (
              <button type="button" disabled={busy} onClick={() => void save("")}>
                Disconnect voice key
              </button>
            )}
            {callTarget && !active && (
              <button
                type="button"
                onClick={() => {
                  setCallTarget(null);
                  setOpen(false);
                }}
              >
                Done
              </button>
            )}
          </section>
        </PopoverPopup>
      </Popover>
      <audio ref={audio} hidden />
    </div>
  );
}
