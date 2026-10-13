import { useEffect, useRef, type RefObject } from "react";
import { AudioLines, Square, X } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DictationRecorder } from "./dictationRecorder";
import { DictationModelDownload } from "./DictationModelDownload";
import { useDictationModel } from "./useDictationModel";
import { useDictationRecorder } from "./useDictationRecorder";
import {
  draftHasFocus,
  releaseHeldRecording,
  tapRecording,
  VOICE_HOLD_EVENT,
  type VoiceHoldDetail,
} from "./voiceHold";

export function VoiceDictation({
  onTranscript,
  onLive,
  onCancel,
  controlRef,
  shortcutLabel,
}: {
  onTranscript: (text: string) => void;
  /** The user discarded this recording; anything shown for it should be removed. */
  onCancel?: () => void;
  /**
   * Receives the words heard so far while recording, and an empty string when
   * the preview ends. Without it the preview shows in a panel above the controls.
   */
  onLive?: (text: string) => void;
  /** Gives a keyboard shortcut the recorder to toggle, stop or cancel. */
  controlRef?: RefObject<DictationRecorder | null>;
  /** The keybinding that toggles dictation, shown in the button's label. */
  shortcutLabel?: string | null;
}) {
  const { state, error, model, live, previewPaused, recorder } = useDictationRecorder({
    onTranscript,
    onCancel,
  });
  const download = useDictationModel();
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = recorder;
    return () => {
      controlRef.current = null;
    };
  }, [controlRef, recorder]);
  // What has been heard so far, shown greyed while recording. The draft only
  // changes when the final transcript arrives.
  const shownLive = state === "idle" ? "" : live;
  // Read through a ref so a new callback identity on each parent render does not re-send the same words.
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  useEffect(() => {
    onLiveRef.current?.(shownLive);
  }, [shownLive]);
  useEffect(() => () => onLiveRef.current?.(""), []);
  const active = state === "starting" || state === "recording";
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      recorder.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, recorder]);
  // The voice key belongs to the draft on screen, and first to the one being typed in.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const heldByKey = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (event: Event) => {
      const detail = (event as CustomEvent<VoiceHoldDetail>).detail;
      if (!("claimed" in detail)) {
        // A quick tap leaves the recording it started running; the next press finishes it.
        if (heldByKey.current && detail.phase !== "keep") {
          releaseHeldRecording(recorder, detail.phase);
        }
        heldByKey.current = false;
        return;
      }
      const root = rootRef.current;
      if (detail.claimed || !root || root.offsetParent === null) return;
      if (detail.requireFocus && !draftHasFocus(root)) return;
      detail.claimed = true;
      if (detail.phase === "toggle") {
        tapRecording(recorder, detail.autoStop);
        return;
      }
      if (detail.phase === "press") {
        // Only a recording this press started is ended by letting go after a hold.
        heldByKey.current = recorder.getSnapshot().state === "idle";
        tapRecording(recorder, detail.autoStop);
        return;
      }
      // A recording started by hand keeps running; a hold only ends what it started.
      if (recorder.getSnapshot().state !== "idle") return;
      heldByKey.current = true;
      void recorder.start();
    };
    window.addEventListener(VOICE_HOLD_EVENT, onKey);
    return () => window.removeEventListener(VOICE_HOLD_EVENT, onKey);
  }, [recorder]);
  const modelName = model || download.status?.model || "";
  const dictateLabel = `Dictate locally into this draft${shortcutLabel ? ` (${shortcutLabel})` : ""}`;
  const micButton = (
    <button
      type="button"
      data-wb-voice-main=""
      onClick={() => void recorder.start()}
      aria-label={dictateLabel}
    >
      <AudioLines size={16} />
    </button>
  );
  return (
    <div data-wb-voice="" data-state={state} ref={rootRef}>
      {state === "idle" ? (
        <>
          {shortcutLabel ? (
            <Tooltip>
              <TooltipTrigger render={micButton} />
              <TooltipPopup side="top">{dictateLabel}</TooltipPopup>
            </Tooltip>
          ) : (
            micButton
          )}
          <DictationModelDownload variant="icon" />
        </>
      ) : (
        <>
          {/* One round button: the wave starts listening, the square finishes. */}
          <button
            type="button"
            data-wb-voice-main=""
            disabled={state !== "recording"}
            aria-label={
              state === "recording"
                ? "Stop And Transcribe"
                : state === "starting"
                  ? "Opening Microphone"
                  : "Transcribing"
            }
            onClick={recorder.stop}
          >
            <Square size={13} fill="currentColor" />
          </button>
          <button type="button" aria-label="Cancel Dictation" onClick={recorder.cancel}>
            <X size={14} />
          </button>
        </>
      )}
      {/* The button says it all for sighted users; the wording is for screen readers. */}
      <small className="sr-only" aria-live="polite">
        {state === "recording"
          ? `${previewPaused ? "Still listening" : "Listening"}${modelName ? `, ${modelName}` : ""}. Escape cancels.`
          : state === "transcribing"
            ? "Transcribing. Audio stays on this computer."
            : state === "starting"
              ? "Opening the microphone."
              : `Voice to draft${modelName ? `, ${modelName}` : ""}. Review before sending.`}
      </small>
      {state !== "idle" && <DictationModelDownload variant="text" />}
      {!onLive && state !== "idle" && (previewPaused || shownLive) && (
        <p data-wb-voice-live="" aria-live="off">
          {previewPaused ? "Still listening…" : shownLive}
          {state === "recording" && !previewPaused ? "…" : ""}
        </p>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
