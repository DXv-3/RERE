import { useEffect, useRef, useState } from "react";

import { useStartThreadFromText } from "../../hooks/useStartThreadFromText";
import { getClientSettings } from "../../hooks/useSettings";
import { useDictationRecorder } from "./useDictationRecorder";
import { createVoiceCommandController } from "./voiceCommandController";
import { finishVoiceHold, offerVoiceHold } from "./voiceHold";

/**
 * The voice key outside a draft. The desktop app reports the key from any app; what is said
 * becomes the first message of a new thread. A pill above every app follows the command
 * from listening to started, so this window never has to come forward.
 */
export function VoiceCommandCoordinator() {
  const startThread = useStartThreadFromText();
  const startThreadRef = useRef(startThread);
  const controllerRef = useRef<ReturnType<typeof createVoiceCommandController> | null>(null);
  const { recorder } = useDictationRecorder({
    onTranscript: (text) => controllerRef.current?.onTranscript(text),
    onCancel: () => controllerRef.current?.onRecorderCancel(),
  });
  const [controller] = useState(() =>
    createVoiceCommandController({
      recorder,
      settings: () => {
        const settings = getClientSettings();
        return {
          autoStop: settings.voiceAutoStop,
          sendDelay: settings.voiceSendDelay,
          sounds: settings.voiceSounds,
        };
      },
      hasFocus: () => document.hasFocus(),
      offerDraft: (phase, autoStop) => offerVoiceHold(phase, autoStop),
      finishDraft: (phase) => finishVoiceHold(phase),
      startThread: (text) => startThreadRef.current(text),
      overlay: (state) =>
        void window.desktopBridge?.setVoiceOverlay?.(state).catch(() => undefined),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    }),
  );
  useEffect(() => {
    startThreadRef.current = startThread;
    controllerRef.current = controller;
  });
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(
    () => window.desktopBridge?.onMenuAction?.((action) => controller.onAction(action)),
    [controller],
  );

  // Live words, transcription starting and failures all arrive as recorder changes.
  useEffect(
    () => recorder.subscribe(() => controller.onRecorderChange(recorder.getSnapshot())),
    [controller, recorder],
  );

  return null;
}
