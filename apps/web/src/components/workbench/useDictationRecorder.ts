import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  createDictationRecorder,
  type DictationHandlers,
  type DictationRecorder,
  type DictationSnapshot,
} from "./dictationRecorder";

/**
 * A dictation recorder tied to this component's lifetime. `handlers` may change on every
 * render; the latest are always used. Unmounting stops the microphone and drops any
 * transcription still in flight.
 */
export function useDictationRecorder(
  handlers: DictationHandlers,
): DictationSnapshot & { readonly recorder: DictationRecorder } {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  const [recorder] = useState(() => createDictationRecorder(() => latest.current));
  useEffect(() => {
    recorder.attach();
    return recorder.dispose;
  }, [recorder]);
  const snapshot = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getSnapshot,
  );
  return { ...snapshot, recorder };
}
