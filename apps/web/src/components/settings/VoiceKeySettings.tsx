import type { DesktopVoiceKeyStatus, SnapShotKeyChord, VoiceKey } from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { useEffect, useState, type KeyboardEvent } from "react";

import { formatShortcutLabel } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import {
  effectiveVoiceKey,
  globeKeyWarning,
  VOICE_KEY_LABELS,
  VOICE_KEY_MODE_LABELS,
  voiceKeyChoices,
} from "./VoiceKeySettings.logic";

/** The key that starts talking from any app, and how a spoken command behaves. Desktop app only. */
export function VoiceKeySettings() {
  const isMac = isMacPlatform(navigator.platform);
  const savedKey = useScopedSettings((settings) => settings.voiceKey);
  const mode = useScopedSettings((settings) => settings.voiceKeyMode);
  const shortcut = useScopedSettings((settings) => settings.voiceKeyShortcut);
  const autoStop = useScopedSettings((settings) => settings.voiceAutoStop);
  const sendDelay = useScopedSettings((settings) => settings.voiceSendDelay);
  const sounds = useScopedSettings((settings) => settings.voiceSounds);
  const updateSettings = useUpdateScopedSettings();
  const key = effectiveVoiceKey(savedKey, isMac);
  const shortcutLabel = formatShortcutLabel(shortcut, navigator.platform);

  // Asked again whenever the key changes, and when the user comes back from System Settings.
  const [status, setStatus] = useState<DesktopVoiceKeyStatus | null>(null);
  useEffect(() => {
    let current = true;
    const read = () =>
      void window.desktopBridge
        ?.getVoiceKeyStatus?.()
        .then((next) => {
          if (current) setStatus(next);
        })
        .catch(() => undefined);
    // The desktop app applies a new key a moment after the setting is saved.
    const settle = setTimeout(read, 400);
    window.addEventListener("focus", read);
    return () => {
      current = false;
      clearTimeout(settle);
      window.removeEventListener("focus", read);
    };
  }, [key, mode, shortcutLabel]);

  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recordShortcut = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.key === "Tab" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (["Shift", "Meta", "OS", "Control", "Alt", "AltGraph"].includes(event.key)) return;
    // A global shortcut without a modifier would take that key from every app.
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setRecordError("Add Control, Option, Shift or Command to the shortcut.");
      return;
    }
    const input = keybindingFromKeyboardEvent(event, navigator.platform);
    const next = input ? parseKeybindingShortcut(input) : null;
    if (!next) return;
    setRecording(false);
    setRecordError(null);
    updateSettings({ voiceKeyShortcut: next as SnapShotKeyChord });
  };

  const warning = globeKeyWarning(key, status?.globeKeyAction);
  const unavailable =
    key === "shortcut" && status !== null && !status.active
      ? `${shortcutLabel} is used by another app. Record a different shortcut.`
      : null;
  const where =
    "With a draft open here, the words go into it. From any other app, they start a new thread.";

  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-key")}
        description={
          key === "off"
            ? "Pick a key to talk to CodeWrench from any app."
            : `Press it and speak. ${where}`
        }
        control={
          <Select
            value={key}
            onValueChange={(value) => {
              if (voiceKeyChoices(isMac).includes(value as VoiceKey)) {
                updateSettings({ voiceKey: value as VoiceKey });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Voice key">
              <SelectValue>{VOICE_KEY_LABELS[key]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {voiceKeyChoices(isMac).map((choice) => (
                <SelectItem key={choice} hideIndicator value={choice}>
                  {VOICE_KEY_LABELS[choice]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {warning ? (
        <SettingsRow
          title="macOS also uses the Fn key"
          description={warning}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => void window.desktopBridge?.openKeyboardSettings?.()}
            >
              Open Keyboard Settings
            </Button>
          }
        />
      ) : null}
      {key === "shortcut" ? (
        <SettingsRow
          title="Voice shortcut"
          description={
            recordError ??
            unavailable ??
            "Works from any app. A shortcut is always tap to start and tap to finish."
          }
          control={
            <Button
              type="button"
              size="xs"
              variant={recording ? "secondary" : "outline"}
              aria-label={`Record voice shortcut, currently ${shortcutLabel}`}
              aria-pressed={recording}
              data-keybinding-capture=""
              onClick={() => {
                setRecordError(null);
                setRecording(true);
              }}
              onKeyDown={recordShortcut}
              onBlur={() => setRecording(false)}
            >
              {recording ? "Press a shortcut…" : shortcutLabel}
            </Button>
          }
        />
      ) : null}
      {key !== "off" && key !== "shortcut" ? (
        <SettingsRow
          title="Voice key press"
          description="Tap or hold: listening starts the moment you press. Tap, and it listens until you tap again; hold, and it finishes when you let go. Hold only waits for a firm press and always ends on release. Pressing another key with it never starts a recording."
          control={
            <Select
              value={mode}
              onValueChange={(value) => {
                if (value === "tap" || value === "hold") updateSettings({ voiceKeyMode: value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Voice key press">
                <SelectValue>{VOICE_KEY_MODE_LABELS[mode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(VOICE_KEY_MODE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} hideIndicator value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {key !== "off" ? (
        <>
          <SettingsRow
            title="Finish when I stop talking"
            description="After a tap, a two-second pause finishes the recording for you. Holding the key always waits for you to let go."
            control={
              <Switch
                checked={autoStop}
                onCheckedChange={(checked) => updateSettings({ voiceAutoStop: checked })}
                aria-label="Finish when I stop talking"
              />
            }
          />
          <SettingsRow
            title="Pause before sending a spoken command"
            description="Shows what was heard for three seconds before it starts a thread. Esc cancels; tapping the key sends at once. Words dictated into a draft are never sent for you."
            control={
              <Switch
                checked={sendDelay}
                onCheckedChange={(checked) => updateSettings({ voiceSendDelay: checked })}
                aria-label="Pause before sending a spoken command"
              />
            }
          />
          <SettingsRow
            title="Voice sounds"
            description="A short sound when listening starts and when it stops."
            control={
              <Switch
                checked={sounds}
                onCheckedChange={(checked) => updateSettings({ voiceSounds: checked })}
                aria-label="Voice sounds"
              />
            }
          />
        </>
      ) : null}
    </>
  );
}
