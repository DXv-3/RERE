import type { RememberedThread } from "./tabMemory";

export function detachedThreadUrl(origin: string, thread: RememberedThread): string {
  const url = new URL(
    `/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
    origin,
  );
  url.searchParams.set("detachedThread", "1");
  return url.href;
}

export async function openThreadWindow(thread: RememberedThread): Promise<void> {
  if (window.desktopBridge) {
    if (!window.desktopBridge.openThreadWindow)
      throw new Error("Update the desktop app to open separate session windows.");
    await window.desktopBridge.openThreadWindow(thread);
    return;
  }
  // Open synchronously from the button gesture. noopener keeps the two sessions independent.
  window.open(
    detachedThreadUrl(window.location.origin, thread),
    "_blank",
    "noopener,noreferrer,popup,width=1000,height=800",
  );
}

export function isDetachedThreadWindow(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("detachedThread") === "1"
  );
}
