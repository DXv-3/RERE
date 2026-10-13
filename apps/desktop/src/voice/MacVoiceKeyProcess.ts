// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native key poller with Node.

import * as NodeChildProcess from "node:child_process";

export type VoiceKeyEvent = "press" | "tap" | "down" | "up" | "cancel";
export type MacVoiceKey = "fn" | "rightOption" | "rightCommand";
export type VoiceKeyMode = "tap" | "hold";

/** How long the key must be held alone in hold mode before a recording starts. */
const VOICE_KEY_HOLD_MS = 300;
/** How long the key must be down alone before a press counts, so Fn+arrow never starts one. */
const VOICE_KEY_PRESS_MS = 75;
/** A press released sooner than this is a tap; held longer, releasing it ends the recording. */
const VOICE_KEY_TAP_MS = 400;
const POLL_MS = 25;

// The flag that says the key is down, the modifier flag it raises (ignored when looking for
// other modifiers), and the flag of its left-hand twin, which must be up.
const MAC_VOICE_KEYS: Record<MacVoiceKey, readonly [down: number, own: number, twin: number]> = {
  fn: [0x800000, 0x800000, 0],
  rightOption: [0x40, 0x80000, 0x20],
  rightCommand: [0x10, 0x100000, 0x8],
};

// Electron cannot see Fn or tell a right modifier from a left one, so a background osascript
// reads the keyboard state, the same way the window capture shortcut watches modifier pairs.
// It goes background-only first so it never gets a Dock tile.
//
// Tap mode serves both habits with one key. It prints "press" as soon as the key has been down
// alone for a moment, then on release "tap" for a quick press (the recording carries on until
// the next press) or "up" for a held one (the recording ends there), so tapping and holding
// both work without a setting. Hold mode prints "down" once the key has been held alone for the
// hold time and "up" on release. Another key joining spoils the press: "cancel" if a recording
// was started. Arrow and function keys raise the Fn flag by themselves; they count as another
// key, so they never match.
const POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function otherKeyDown() {
  for (let key = 0; key < 128; key++) {
    // 54-63 are the modifier keys, which are read from the flags instead.
    if (key >= 54 && key <= 63) continue;
    if ($.CGEventSourceKeyState(0, key)) return true;
  }
  return false;
}
function run(argv) {
  const down = Number(argv[0]);
  const own = Number(argv[1]);
  const twin = Number(argv[2]);
  const hold = argv[3] === "hold";
  const holdTicks = Number(argv[4]);
  const interval = Number(argv[5]);
  const pressTicks = Number(argv[6]);
  const tapTicks = Number(argv[7]);
  const MODIFIERS = 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x800000;
  let held = 0;
  let talking = false;
  let spoiled = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const flags = $.CGEventSourceFlagsState(0);
    if ((flags & down) !== down) {
      if (talking) console.log(!hold && held < tapTicks ? "tap" : "up");
      talking = false;
      spoiled = false;
      held = 0;
    } else if (!spoiled) {
      held++;
      if ((flags & MODIFIERS & ~own) !== 0 || (flags & twin) !== 0 || otherKeyDown()) {
        if (talking) console.log("cancel");
        talking = false;
        spoiled = true;
      } else if (!talking && held >= (hold ? holdTicks : pressTicks)) {
        talking = true;
        console.log(hold ? "down" : "press");
      }
    }
    delay(interval);
  }
  return "orphaned";
}`;

const EVENTS: ReadonlySet<string> = new Set<VoiceKeyEvent>([
  "press",
  "tap",
  "down",
  "up",
  "cancel",
]);

/** Resolves with a stop function once the poller is watching. */
export function startMacVoiceKeyProcess(
  key: MacVoiceKey,
  mode: VoiceKeyMode,
  onEvent: (event: VoiceKeyEvent) => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      POLLER_SCRIPT,
      ...MAC_VOICE_KEYS[key].map(String),
      mode,
      String(Math.ceil(VOICE_KEY_HOLD_MS / POLL_MS)),
      String(POLL_MS / 1000),
      String(Math.ceil(VOICE_KEY_PRESS_MS / POLL_MS)),
      String(Math.ceil(VOICE_KEY_TAP_MS / POLL_MS)),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      poller.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        if (!EVENTS.has(message) || !settled || stopped) continue;
        try {
          onEvent(message as VoiceKeyEvent);
        } catch {}
      }
    });
    poller.once("error", (error) => {
      fail(error);
    });
    poller.once("exit", (code) => {
      fail(new Error(`Voice key helper exited with code ${code}`));
    });
  });
}
