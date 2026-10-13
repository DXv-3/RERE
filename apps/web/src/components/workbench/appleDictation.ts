import type { DesktopNativeDictationEvent } from "@t3tools/contracts";

/**
 * Apple's on-device speech engine, as the recorder sees it. The Mac app listens to the
 * microphone itself, so the renderer opens no `getUserMedia` stream for this engine.
 */
export interface NativeSpeech {
  readonly start: () => Promise<void>;
  /** Resolves with everything heard. */
  readonly stop: () => Promise<string>;
  readonly cancel: () => Promise<void>;
  readonly onEvent: (listener: (event: DesktopNativeDictationEvent) => void) => () => void;
}

/** The desktop bridge's native dictation calls, or undefined in builds that predate them. */
export function bridgeNativeSpeech(): NativeSpeech | undefined {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const {
    startNativeDictation,
    stopNativeDictation,
    cancelNativeDictation,
    onNativeDictationEvent,
  } = bridge ?? {};
  if (!startNativeDictation || !stopNativeDictation || !cancelNativeDictation) return undefined;
  return {
    start: startNativeDictation,
    stop: stopNativeDictation,
    cancel: cancelNativeDictation,
    onEvent: (listener) => onNativeDictationEvent?.(listener) ?? (() => undefined),
  };
}

export type NativeSpeechErrorKind = "unavailable" | "permission" | "failed";

/** The helper's error code and message, from the `[code] message` the desktop app puts in the error. */
export function parseNativeSpeechError(message: string): { code: string; message: string } {
  const match = /^\[([a-z_]+)\]\s*([\s\S]*)$/u.exec(message.trim());
  return match
    ? { code: match[1] ?? "unknown", message: match[2] ?? "" }
    : { code: "unknown", message };
}

/**
 * `unavailable` means Apple's engine cannot work here, so Whisper may take over.
 * `permission` means the user said no; falling back would hide the problem, so it is shown.
 */
export function classifyNativeSpeechError(code: string): NativeSpeechErrorKind {
  if (code === "helper_missing" || code === "on_device_unavailable" || code === "unsupported_os") {
    return "unavailable";
  }
  return code === "permission_denied" ? "permission" : "failed";
}

const SPEECH_PERMISSION_HELP =
  "Allow CodeWrench in System Settings > Privacy & Security > Speech Recognition and Microphone, then try again.";

/** What to tell the user when Apple's engine failed and Whisper is not taking over. */
export function nativeSpeechErrorText(code: string, message: string): string {
  if (classifyNativeSpeechError(code) === "permission") {
    return message.includes("System Settings")
      ? message
      : `Speech Recognition or Microphone access is off for CodeWrench. ${SPEECH_PERMISSION_HELP}`;
  }
  return message || "Speech recognition failed.";
}
