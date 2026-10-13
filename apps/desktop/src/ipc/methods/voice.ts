import { DesktopVoiceOverlayState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { readGlobeKeyAction } from "../../voice/globeKey.ts";
import * as VoiceKey from "../../voice/voiceKey.ts";
import { hideVoiceOverlay, showVoiceOverlay } from "../../voice/VoiceOverlay.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as Channels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { trusted } from "./dictation.ts";

const KEYBOARD_SETTINGS_URL = "x-apple.systempreferences:com.apple.Keyboard-Settings.extension";

export const setVoiceOverlay = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_OVERLAY_CHANNEL,
  payload: Schema.NullOr(DesktopVoiceOverlayState),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voice.setOverlay")(function* (state, event) {
    yield* trusted(event);
    if (state === null) {
      hideVoiceOverlay();
      return;
    }
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    showVoiceOverlay(
      state,
      () =>
        void runPromise(desktopWindow.dispatchMenuAction("voice-cancel", { reveal: false })).catch(
          () => undefined,
        ),
      { systemSounds: environment.platform === "darwin" },
    );
  }),
});

export const getVoiceKeyStatus = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_KEY_STATUS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({
    active: Schema.Boolean,
    globeKeyAction: Schema.NullOr(
      Schema.Literals(["nothing", "input-source", "emoji", "dictation", "unknown"]),
    ),
  }),
  handler: Effect.fn("desktop.ipc.voice.keyStatus")(function* (_, event) {
    yield* trusted(event);
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return {
      active: VoiceKey.isActive(),
      globeKeyAction:
        environment.platform === "darwin" ? yield* Effect.promise(readGlobeKeyAction) : null,
    };
  }),
});

export const openKeyboardSettings = DesktopIpc.makeIpcMethod({
  channel: Channels.VOICE_KEYBOARD_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.voice.openKeyboardSettings")(function* (_, event) {
    yield* trusted(event);
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return false;
    return yield* Effect.promise(() =>
      Electron.shell.openExternal(KEYBOARD_SETTINGS_URL).then(
        () => true,
        () => false,
      ),
    );
  }),
});
