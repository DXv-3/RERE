import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  effectiveVoiceKey,
  globeKeyWarning,
  voiceKeyChoices,
  voiceSettingsChanged,
} from "./VoiceKeySettings.logic";

it("offers single keys only where they can be watched", () => {
  expect(voiceKeyChoices(true)).toContain("fn");
  expect(voiceKeyChoices(false)).toEqual(["shortcut", "off"]);
  expect(effectiveVoiceKey("fn", true)).toBe("fn");
  expect(effectiveVoiceKey("fn", false)).toBe("shortcut");
  expect(effectiveVoiceKey("off", false)).toBe("off");
});

it("warns only when Fn is the voice key and macOS will react to it too", () => {
  expect(globeKeyWarning("fn", "nothing")).toBeNull();
  expect(globeKeyWarning("rightOption", "emoji")).toBeNull();
  expect(globeKeyWarning("fn", null)).toBeNull();
  expect(globeKeyWarning("fn", "emoji")).toContain("opens the emoji picker");
  expect(globeKeyWarning("fn", "dictation")).toContain("starts Apple dictation");
  expect(globeKeyWarning("fn", "unknown")).toContain("may also react");
});

it("knows when a voice setting has left its default", () => {
  const defaults = DEFAULT_CLIENT_SETTINGS;
  expect(voiceSettingsChanged({ ...defaults }, defaults)).toBe(false);
  // A copy of the same shortcut is not a change.
  expect(
    voiceSettingsChanged(
      { ...defaults, voiceKeyShortcut: { ...defaults.voiceKeyShortcut } },
      defaults,
    ),
  ).toBe(false);
  expect(voiceSettingsChanged({ ...defaults, voiceKeyMode: "hold" }, defaults)).toBe(true);
  expect(
    voiceSettingsChanged(
      { ...defaults, voiceKeyShortcut: { ...defaults.voiceKeyShortcut, key: "k" } },
      defaults,
    ),
  ).toBe(true);
});

it("defaults dictation to the auto engine and notices a change", () => {
  const defaults = DEFAULT_CLIENT_SETTINGS;
  expect(defaults.dictationEngine).toBe("auto");
  expect(voiceSettingsChanged({ ...defaults, dictationEngine: "whisper" }, defaults)).toBe(true);
});
