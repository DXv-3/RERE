// @effect-diagnostics nodeBuiltinImport:off -- Plays macOS system sounds with afplay.

import * as NodeChildProcess from "node:child_process";

import type { DesktopVoiceOverlayState } from "@t3tools/contracts";
import * as Electron from "electron";

const WIDTH = 440;
const HEIGHT = 92;
const BOTTOM_MARGIN = 72;
const CANCEL_URL = "codewrench-voice://cancel";
const SOUNDS = {
  start: "/System/Library/Sounds/Tink.aiff",
  stop: "/System/Library/Sounds/Pop.aiff",
} as const;

// The page is fixed markup; every changing word arrives through render() and textContent.
const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none;cursor:default}
#pill{box-sizing:border-box;position:absolute;inset:8px;display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;border-radius:18px;background:rgba(24,24,27,.94);color:#fafafa;box-shadow:0 8px 28px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12)}
#dot{flex:none;width:10px;height:10px;border-radius:50%;background:#a1a1aa}
[data-phase=listening] #dot{background:#ef4444;animation:pulse 1.2s ease-in-out infinite}
[data-phase=sending] #dot{background:#f59e0b}
[data-phase=done] #dot{background:#22c55e}
[data-phase=error] #dot{background:#ef4444}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){[data-phase=listening] #dot{animation:none}}
#words{min-width:0;flex:1}
#title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#text{margin-top:2px;font-size:12px;line-height:1.35;color:#d4d4d8;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#text:empty{display:none}
#cancel{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;color:#d4d4d8;text-decoration:none;font-size:15px;cursor:pointer}
#cancel:hover{background:rgba(255,255,255,.14);color:#fff}
[data-phase=done] #cancel,[data-phase=error] #cancel,[data-phase=transcribing] #cancel{visibility:hidden}
</style><div id="pill" data-phase="listening" role="status"><span id="dot"></span><div id="words"><div id="title"></div><div id="text"></div></div><a id="cancel" href="${CANCEL_URL}" aria-label="Cancel">✕</a></div>
<script>function render(s){document.getElementById("pill").dataset.phase=s.phase;document.getElementById("title").textContent=s.title;document.getElementById("text").textContent=s.text}</script>`;

let overlay: Electron.BrowserWindow | null = null;
let ready = false;
let latest: DesktopVoiceOverlayState | null = null;
let escapeHeld = false;
let cancel: () => void = () => undefined;

const push = () => {
  if (!overlay || overlay.isDestroyed() || !ready || !latest) return;
  void overlay.webContents
    .executeJavaScript(`render(${JSON.stringify(latest)})`)
    .catch(() => undefined);
  if (!overlay.isVisible()) overlay.showInactive();
};

// Escape is taken from other apps only while there is something to stop.
const holdEscape = (held: boolean) => {
  if (held === escapeHeld) return;
  if (held) escapeHeld = Electron.globalShortcut.register("Escape", () => cancel());
  else {
    Electron.globalShortcut.unregister("Escape");
    escapeHeld = false;
  }
};

function createOverlay(): Electron.BrowserWindow {
  const display = Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
  const area = display.workArea;
  const window = new Electron.BrowserWindow({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height - HEIGHT - BOTTOM_MARGIN),
    width: WIDTH,
    height: HEIGHT,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "CodeWrench Voice",
    transparent: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  // Without skipTransformProcessType macOS briefly drops the app from the Dock.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // The cancel control is a link; nothing in this window ever really navigates.
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === CANCEL_URL) cancel();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.once("did-finish-load", () => {
    ready = true;
    push();
  });
  window.once("closed", () => {
    if (overlay === window) {
      overlay = null;
      ready = false;
    }
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
  return window;
}

/**
 * Shows what a voice command is doing in a small pill above every app, without taking focus.
 * `onCancel` runs when the user presses Escape or the pill's cancel control. The sounds are
 * macOS system sounds, so `systemSounds` is false everywhere else.
 */
export function showVoiceOverlay(
  state: DesktopVoiceOverlayState,
  onCancel: () => void,
  options: { readonly systemSounds: boolean },
): void {
  cancel = onCancel;
  latest = state;
  if (state.sound && options.systemSounds) {
    NodeChildProcess.spawn("/usr/bin/afplay", [SOUNDS[state.sound]], { stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
  }
  holdEscape(state.phase === "listening" || state.phase === "sending");
  if (!overlay || overlay.isDestroyed()) {
    ready = false;
    overlay = createOverlay();
  }
  push();
}

export function hideVoiceOverlay(): void {
  latest = null;
  holdEscape(false);
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
  ready = false;
}
