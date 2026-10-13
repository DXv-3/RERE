import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { resolveVoiceKeyBinding } from "./voiceKey.ts";

const settings = (patch: Partial<typeof DEFAULT_CLIENT_SETTINGS>) => ({
  ...DEFAULT_CLIENT_SETTINGS,
  ...patch,
});

describe("resolveVoiceKeyBinding", () => {
  it("taps Fn on a Mac by default", () => {
    expect(resolveVoiceKeyBinding(DEFAULT_CLIENT_SETTINGS, "darwin")).toEqual({
      kind: "key",
      key: "fn",
      mode: "tap",
    });
  });

  it("watches the chosen key in the chosen mode", () => {
    expect(
      resolveVoiceKeyBinding(settings({ voiceKey: "rightOption", voiceKeyMode: "hold" }), "darwin"),
    ).toEqual({ kind: "key", key: "rightOption", mode: "hold" });
  });

  it("uses the recorded shortcut when asked, and wherever a single key cannot be watched", () => {
    const shortcut = { kind: "shortcut", accelerator: "Control+Shift+V" };
    expect(resolveVoiceKeyBinding(settings({ voiceKey: "shortcut" }), "darwin")).toEqual(shortcut);
    expect(resolveVoiceKeyBinding(DEFAULT_CLIENT_SETTINGS, "linux")).toEqual(shortcut);
    expect(resolveVoiceKeyBinding(DEFAULT_CLIENT_SETTINGS, "win32")).toEqual(shortcut);
  });

  it("is off when switched off, on every platform", () => {
    expect(resolveVoiceKeyBinding(settings({ voiceKey: "off" }), "darwin")).toEqual({
      kind: "off",
    });
    expect(resolveVoiceKeyBinding(settings({ voiceKey: "off" }), "linux")).toEqual({ kind: "off" });
  });
});
