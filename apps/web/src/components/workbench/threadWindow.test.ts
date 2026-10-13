// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { detachedThreadUrl, openThreadWindow } from "./threadWindow";
const target = { environmentId: "env/remote", threadId: "thread:one?two#three" };
afterEach(() => {
  delete window.desktopBridge;
  vi.restoreAllMocks();
});
it("encodes a same-origin detached session route", () => {
  const url = new URL(detachedThreadUrl("https://example.com", target));
  expect(url.origin).toBe("https://example.com");
  expect(url.pathname).toBe("/env%2Fremote/thread%3Aone%3Ftwo%23three");
  expect(url.searchParams.get("detachedThread")).toBe("1");
});
it("uses the native window bridge in the desktop app", async () => {
  const native = vi.fn().mockResolvedValue(undefined);
  window.desktopBridge = { openThreadWindow: native } as unknown as NonNullable<
    typeof window.desktopBridge
  >;
  const browser = vi.spyOn(window, "open");
  await openThreadWindow(target);
  expect(native).toHaveBeenCalledWith(target);
  expect(browser).not.toHaveBeenCalled();
});
it("reports an outdated desktop bridge rather than opening an external browser", async () => {
  window.desktopBridge = {} as NonNullable<typeof window.desktopBridge>;
  await expect(openThreadWindow(target)).rejects.toThrow("Update the desktop app");
});
it("opens a browser window without sharing its opener", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await openThreadWindow(target);
  expect(open).toHaveBeenCalledWith(
    detachedThreadUrl(window.location.origin, target),
    "_blank",
    expect.stringContaining("noopener,noreferrer"),
  );
});
