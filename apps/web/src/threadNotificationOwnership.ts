const CLAIM_LOCK = "codewrench:notification-claims";
const FOCUS_LOCK = "codewrench:notification-focus";
const STORAGE_KEY = "codewrench:notification-claims:v1";
const CLAIM_TTL_MS = 120_000;
const MAX_CLAIMS = 512;
let warned = false;
let memoryClaims: Array<{ key: string; at: number }> = [];

function warnLimitedCoordination() {
  if (warned) return;
  warned = true;
  console.warn(
    "Cross-window notification coordination is unavailable. Browser alerts may be duplicated; use a secure browser with Web Locks and site storage enabled.",
  );
}

function locks() {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

export function notificationWindowFocused() {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** A focused renderer owns suppression, even when it deliberately sends nothing for a viewed chat.
 * Web Locks disappear when a window closes/crashes, without a heartbeat or stale focus lease.
 */
export function trackNotificationWindowFocus(): () => void {
  const manager = locks();
  if (window.desktopBridge?.claimThreadNotification || !manager) return () => {};
  let release: (() => void) | undefined;
  let controller: AbortController | undefined;
  const clear = () => {
    controller?.abort();
    controller = undefined;
    release?.();
    release = undefined;
  };
  const refresh = () => {
    if (!notificationWindowFocused()) {
      clear();
      return;
    }
    if (controller) return;
    controller = new AbortController();
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void manager
      .request(FOCUS_LOCK, { signal: controller.signal }, () => held)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          warnLimitedCoordination();
      });
  };
  window.addEventListener("focus", refresh);
  window.addEventListener("blur", clear);
  window.addEventListener("pagehide", clear);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    clear();
    window.removeEventListener("focus", refresh);
    window.removeEventListener("blur", clear);
    window.removeEventListener("pagehide", clear);
    window.removeEventListener("pageshow", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

function claimInStorage(key: string): boolean {
  const now = Date.now();
  if (
    memoryClaims.some(
      (claim) => claim.key === key && claim.at <= now && now - claim.at < CLAIM_TTL_MS,
    )
  )
    return false;
  let storage: Storage | undefined;
  let claims = memoryClaims;
  try {
    storage = window.localStorage;
    if (!storage) throw new Error("Storage unavailable");
    const stored: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      claims = stored.filter(
        (entry): entry is { key: string; at: number } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.key === "string" &&
          typeof entry.at === "number" &&
          Number.isFinite(entry.at),
      );
    }
  } catch {
    warnLimitedCoordination();
  }
  claims = claims.filter(({ at }) => at <= now && now - at < CLAIM_TTL_MS).slice(-MAX_CLAIMS);
  if (claims.some((claim) => claim.key === key)) return false;
  claims.push({ key, at: now });
  memoryClaims = claims.slice(-MAX_CLAIMS);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(memoryClaims));
  } catch {
    warnLimitedCoordination();
  }
  return true;
}

/** Claims one attempt, not confirmed OS delivery. Keys contain identifiers, never message text.
 * Native main owns arbitration. Browser claims are atomic only with Web Locks + shared storage;
 * the storage-only fallback cannot prevent simultaneous read/write races across windows.
 */
export async function claimThreadNotification(key: string): Promise<boolean> {
  const nativeClaim = window.desktopBridge?.claimThreadNotification;
  if (nativeClaim) {
    try {
      return await nativeClaim(key);
    } catch {
      console.warn(
        "Native notification ownership could not be checked; skipping this alert to avoid duplicate delivery.",
      );
      return false;
    }
  }
  const manager = locks();
  if (!manager) {
    warnLimitedCoordination();
    return claimInStorage(key);
  }
  try {
    return await manager.request(CLAIM_LOCK, async () => {
      if (!notificationWindowFocused()) {
        const snapshot = await manager.query();
        if (
          [...(snapshot.held ?? []), ...(snapshot.pending ?? [])].some(
            ({ name }) => name === FOCUS_LOCK,
          )
        )
          return false;
      }
      return claimInStorage(key);
    });
  } catch {
    warnLimitedCoordination();
    return claimInStorage(key);
  }
}
