import { useEffect, useSyncExternalStore } from "react";
import { dictationErrorMessage } from "./dictationRecorder";
import type { DesktopDictationModelProgress, DesktopDictationStatus } from "@t3tools/contracts";

export interface DictationModelState {
  readonly status: DesktopDictationStatus | null;
  readonly progress: DesktopDictationModelProgress | null;
  readonly downloading: boolean;
  readonly error: string;
}

// Server rendering and some tests have no window; the controls then offer nothing.
const bridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge);
const CANCELLED = "Download cancelled.";
let state: DictationModelState = { status: null, progress: null, downloading: false, error: "" };
const listeners = new Set<() => void>();
const set = (patch: Partial<DictationModelState>) => {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
};

/** Reads the desktop app's dictation status; the model name and whether a better model can be fetched. */
export async function refreshDictationStatus() {
  let status: DesktopDictationStatus | undefined;
  try {
    status = await bridge()?.getDictationStatus?.();
  } catch {
    return;
  }
  if (!status) return;
  // A download started elsewhere (another window of this app) shows up here until it ends.
  set({ status, ...(status.modelDownload ? { progress: status.modelDownload } : {}) });
}

export async function downloadDictationModel() {
  const desktop = bridge();
  if (!desktop?.downloadDictationModel || state.downloading) return;
  set({ downloading: true, error: "", progress: { bytesDone: 0, bytesTotal: 0 } });
  try {
    await desktop.downloadDictationModel();
  } catch (error) {
    const message = dictationErrorMessage(error, "The download failed.");
    if (message !== CANCELLED) set({ error: message });
  } finally {
    set({ downloading: false, progress: null });
    await refreshDictationStatus();
  }
}

export const cancelDictationModelDownload = () => bridge()?.cancelDictationModelDownload?.();

let unsubscribeProgress: (() => void) | null = null;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Progress arrives for downloads this window did not start too, so listen while anyone is watching.
  unsubscribeProgress ??=
    bridge()?.onDictationModelProgress?.((progress) => set({ progress })) ?? null;
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeProgress?.();
      unsubscribeProgress = null;
    }
  };
};

/** Shared by every dictation control, so progress and errors agree wherever they are shown. */
export function useDictationModel(): DictationModelState & {
  /** The accurate model can be downloaded from this build of the desktop app. */
  readonly canDownload: boolean;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  useEffect(() => {
    void refreshDictationStatus();
  }, []);
  return {
    ...current,
    // Apple's engine has no model, so the Whisper download means nothing while it is in use.
    canDownload:
      current.status?.engine !== "apple" &&
      current.status?.betterModelAvailable === true &&
      typeof bridge()?.downloadDictationModel === "function",
  };
}
