import type { ClientSettings } from "@t3tools/contracts/settings";

import completionUrl from "./assets/notification-completion.mp3";
import inputUrl from "./assets/notification-input.mp3";

type NotificationMode = ClientSettings["notificationMode"];
export const NOTIFICATION_MODE_LABELS = {
  off: "Off",
  notifications: "System banners only",
  sound: "Sound only",
  "notifications-and-sound": "System banners and sound",
} satisfies Record<NotificationMode, string>;

export function hasNotificationSound(mode: NotificationMode) {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasDesktopNotifications(mode: NotificationMode) {
  return mode === "notifications" || mode === "notifications-and-sound";
}

export type SystemNotificationPermission = NotificationPermission | "unavailable";

export function getSystemNotificationPermission(): SystemNotificationPermission {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unavailable"
    : Notification.permission;
}

/** Invoke directly from a gesture; never prompt for background delivery. */
export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  const permission = getSystemNotificationPermission();
  if (permission !== "default") return permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "unavailable";
  }
}

export const SYSTEM_NOTIFICATION_PERMISSION_MESSAGES = {
  unavailable:
    "System banners need the desktop app or a supported secure browser (HTTPS or localhost).",
  default:
    "System banner permission has not been granted. Choose a system banner mode to request it. If one is already selected, use Send test.",
  denied:
    "System banners are blocked. Allow notifications in your browser’s site settings or macOS System Settings → Notifications → CodeWrench, then return here. Choose a system banner mode or, if already selected, use Send test.",
  granted:
    "Notification permission is granted. If banners are missing on macOS, check System Settings → Notifications → CodeWrench (or your browser): Allow Notifications and Banners or Alerts. Also check Focus / Do Not Disturb. Permission alone does not confirm banner delivery.",
} satisfies Record<SystemNotificationPermission, string>;

export function reportSystemNotificationError() {
  // Do not log notification titles or bodies: they can contain private thread content.
  console.warn(
    "System notification delivery failed. Check notification permissions, system banner settings and Focus / Do Not Disturb.",
  );
}

let originalFavicon: HTMLLinkElement | undefined;
let badgeFavicon: HTMLLinkElement | undefined;

export function setNotificationBadge(count: number) {
  const bridge = window.desktopBridge;
  let image: string | null = null;
  if (count > 0 && (!bridge || bridge.getClientPlatform?.() === "win32")) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(32, 32, 28, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "white";
      context.font = `600 ${count > 9 ? 30 : 40}px "Segoe UI", sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), 32, 34);
      image = canvas.toDataURL("image/png");
    }
  }
  if (!bridge) {
    if (image) {
      if (!badgeFavicon) {
        originalFavicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? undefined;
        badgeFavicon = document.createElement("link");
        badgeFavicon.rel = "icon";
        badgeFavicon.type = "image/png";
        badgeFavicon.sizes.value = "64x64";
        originalFavicon?.remove();
        document.head.append(badgeFavicon);
      }
      badgeFavicon.href = image;
    } else if (badgeFavicon) {
      badgeFavicon.remove();
      badgeFavicon = undefined;
      if (originalFavicon) document.head.append(originalFavicon);
      originalFavicon = undefined;
    }
  }
  void bridge?.setNotificationBadge?.({ count, image }).catch(() => undefined);
}

let audioContext: AudioContext | undefined;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** Called from a gesture so browsers allow later background playback. */
export function unlockNotificationAudio(): Promise<boolean> {
  try {
    audioContext ??= new AudioContext();
    return audioContext.resume().then(
      () => audioContext?.state === "running",
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export async function playNotificationSound(
  kind: "completion" | "input",
  shouldPlay: () => boolean,
) {
  if (!audioContext || audioContext.state !== "running") return false;
  const context = audioContext;
  const url = kind === "completion" ? completionUrl : inputUrl;
  try {
    let buffer = buffers.get(url);
    if (!buffer) {
      buffer = fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data));
      buffers.set(url, buffer);
    }
    const decoded = await buffer;
    if (!shouldPlay() || context.state !== "running") return false;
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(context.destination);
    source.start();
    return true;
  } catch {
    buffers.delete(url);
    return false;
  }
}

/** Explicit user test; completion length, quiet hours and current-thread suppression do not apply. */
export async function testNotificationDelivery(
  mode: NotificationMode,
  onDeliveryError?: (message: string) => void,
): Promise<string> {
  if (mode === "off") return "Choose a notification mode before testing.";
  // Start both permission requests from the click, before awaiting either one.
  const soundReady = hasNotificationSound(mode)
    ? unlockNotificationAudio()
    : Promise.resolve(false);
  const permission = hasDesktopNotifications(mode)
    ? requestSystemNotificationPermission()
    : Promise.resolve(null);
  const messages: string[] = [];
  const granted = await permission;
  if (hasDesktopNotifications(mode)) {
    if (granted === "granted") {
      try {
        const notification = new Notification("CodeWrench notification test", {
          body: "Session alerts can use this notification channel.",
          tag: "codewrench-notification-test",
          silent: true,
        });
        notification.addEventListener(
          "error",
          () => {
            reportSystemNotificationError();
            onDeliveryError?.(
              "The test banner could not be delivered. Check system/browser notification settings and try again.",
            );
          },
          { once: true },
        );
        notification.addEventListener(
          "click",
          () => {
            window.focus();
            notification.close();
          },
          { once: true },
        );
        messages.push(
          "Test banner requested. If it does not appear, check system notification settings and Focus / Do Not Disturb.",
        );
      } catch {
        messages.push(
          "The system rejected the test banner. Check notification permissions for CodeWrench or your browser.",
        );
      }
    } else messages.push(SYSTEM_NOTIFICATION_PERMISSION_MESSAGES[granted ?? "unavailable"]);
  }
  if (hasNotificationSound(mode)) {
    const played = (await soundReady) && (await playNotificationSound("completion", () => true));
    messages.push(
      played
        ? "Test sound started. If inaudible, check volume and the selected audio output."
        : "Test sound could not play. Check site audio permissions, then try again.",
    );
  }
  return messages.join(" ");
}
