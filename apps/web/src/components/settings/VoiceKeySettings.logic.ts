import type {
  ClientSettings,
  DesktopGlobeKeyAction,
  VoiceKey,
  VoiceKeyMode,
} from "@t3tools/contracts";

export const VOICE_KEY_LABELS: Record<VoiceKey, string> = {
  off: "Off",
  fn: "Fn (Globe)",
  rightOption: "Right Option",
  rightCommand: "Right Command",
  shortcut: "Custom shortcut",
};

export const VOICE_KEY_MODE_LABELS: Record<VoiceKeyMode, string> = {
  tap: "Tap or hold",
  hold: "Hold only",
};

/** The keys this computer can watch. A single key needs macOS; a shortcut works anywhere. */
export function voiceKeyChoices(isMac: boolean): readonly VoiceKey[] {
  return isMac ? ["fn", "rightOption", "rightCommand", "shortcut", "off"] : ["shortcut", "off"];
}

/** What the saved key means here: off macOS a single key falls back to the shortcut. */
export function effectiveVoiceKey(key: VoiceKey, isMac: boolean): VoiceKey {
  return key === "off" || key === "shortcut" || isMac ? key : "shortcut";
}

const GLOBE_ACTION_LABELS: Record<Exclude<DesktopGlobeKeyAction, "nothing" | "unknown">, string> = {
  "input-source": "switches the keyboard language",
  emoji: "opens the emoji picker",
  dictation: "starts Apple dictation",
};

/**
 * A warning when macOS will also react to Fn. Null when Fn is not the voice key or macOS
 * is set to do nothing with it.
 */
export function globeKeyWarning(
  key: VoiceKey,
  action: DesktopGlobeKeyAction | null | undefined,
): string | null {
  if (key !== "fn" || action == null || action === "nothing") return null;
  const fix = "Set System Settings → Keyboard → “Press Globe key to” to Do Nothing.";
  return action === "unknown"
    ? `macOS may also react when you press Fn. ${fix}`
    : `macOS also ${GLOBE_ACTION_LABELS[action]} when you press Fn. ${fix}`;
}

type VoiceSettings = Pick<
  ClientSettings,
  | "dictationEngine"
  | "voiceKey"
  | "voiceKeyMode"
  | "voiceKeyShortcut"
  | "voiceAutoStop"
  | "voiceSendDelay"
  | "voiceSounds"
>;

/** Whether any voice setting differs from its default, for "restore defaults". */
export function voiceSettingsChanged(settings: VoiceSettings, defaults: VoiceSettings): boolean {
  const shortcutKeys = ["key", "metaKey", "ctrlKey", "shiftKey", "altKey", "modKey"] as const;
  return (
    settings.dictationEngine !== defaults.dictationEngine ||
    settings.voiceKey !== defaults.voiceKey ||
    settings.voiceKeyMode !== defaults.voiceKeyMode ||
    settings.voiceAutoStop !== defaults.voiceAutoStop ||
    settings.voiceSendDelay !== defaults.voiceSendDelay ||
    settings.voiceSounds !== defaults.voiceSounds ||
    shortcutKeys.some((key) => settings.voiceKeyShortcut[key] !== defaults.voiceKeyShortcut[key])
  );
}
