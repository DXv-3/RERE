import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  startMacVoiceKeyProcess,
  type MacVoiceKey,
  type VoiceKeyEvent,
  type VoiceKeyMode,
} from "./MacVoiceKeyProcess.ts";
import { hideVoiceOverlay } from "./VoiceOverlay.ts";

/**
 * What the voice key reports to the window, which decides whether the words go into the
 * open draft or start a thread. The window is told without being brought forward, so
 * speaking a command does not pull the user out of what they are doing.
 */
const VOICE_KEY_MENU_ACTIONS: Record<VoiceKeyEvent, string> = {
  press: "voice-key-press",
  tap: "voice-key-tap",
  down: "voice-hold-start",
  up: "voice-hold-end",
  cancel: "voice-hold-cancel",
};

export type VoiceKeyBinding =
  | { readonly kind: "off" }
  | { readonly kind: "key"; readonly key: MacVoiceKey; readonly mode: VoiceKeyMode }
  | { readonly kind: "shortcut"; readonly accelerator: string };

/**
 * A single key can only be watched on macOS, and a recorded shortcut has no release to
 * watch for, so everywhere else, and for a shortcut, the key is a tap.
 */
export function resolveVoiceKeyBinding(
  settings: Pick<ClientSettings, "voiceKey" | "voiceKeyMode" | "voiceKeyShortcut">,
  platform: NodeJS.Platform,
): VoiceKeyBinding {
  if (settings.voiceKey === "off") return { kind: "off" };
  if (settings.voiceKey === "shortcut" || platform !== "darwin") {
    return { kind: "shortcut", accelerator: toElectronAccelerator(settings.voiceKeyShortcut) };
  }
  return { kind: "key", key: settings.voiceKey, mode: settings.voiceKeyMode };
}

const bindingId = (binding: VoiceKeyBinding) =>
  binding.kind === "off"
    ? "off"
    : binding.kind === "key"
      ? `key:${binding.key}:${binding.mode}`
      : `shortcut:${binding.accelerator}`;

// One voice key for the app. `wanted` is what the settings last asked for, so a watcher that
// finishes starting after the setting changed again is stopped straight away.
let wanted = "off";
let active: { readonly id: string; readonly stop: () => void } | null = null;

const release = () => {
  active?.stop();
  active = null;
};

/** Makes the voice key match the settings. */
export const configure = Effect.fn("desktop.voice.configure")(function* (settings: ClientSettings) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const binding = resolveVoiceKeyBinding(settings, environment.platform);
  const id = bindingId(binding);
  if (id === wanted) return;
  wanted = id;
  release();
  const report = (event: VoiceKeyEvent) =>
    void runPromise(
      desktopWindow.dispatchMenuAction(VOICE_KEY_MENU_ACTIONS[event], { reveal: false }),
    ).catch(() => undefined);
  const warn = (cause: unknown) =>
    void runPromise(Effect.logWarning("the voice key is unavailable", { cause: String(cause) }));

  if (binding.kind === "shortcut") {
    const { accelerator } = binding;
    // Another app owning the shortcut is not worth failing over; Settings shows it is not set.
    if (Electron.globalShortcut.register(accelerator, () => report("tap"))) {
      active = { id, stop: () => Electron.globalShortcut.unregister(accelerator) };
    } else {
      warn(`${accelerator} is taken by another app`);
    }
    return;
  }
  if (binding.kind === "off") return;
  void startMacVoiceKeyProcess(binding.key, binding.mode, report, (error) => {
    if (active?.id === id) active = null;
    warn(error);
  }).then((stop) => {
    if (wanted === id) active = { id, stop };
    else stop();
  }, warn);
});

/** Whether the configured key is being watched right now. */
export const isActive = () => active !== null && active.id === wanted;

/** Sets the voice key up from the saved settings for the life of the scope. */
export const register = Effect.gen(function* () {
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  yield* configure(Option.getOrElse(yield* clientSettings.get, () => DEFAULT_CLIENT_SETTINGS));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      wanted = "off";
      release();
      hideVoiceOverlay();
    }),
  );
});
