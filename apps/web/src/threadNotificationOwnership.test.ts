import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

function sharedLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  const pending = new Set<string>();
  return {
    request: vi.fn(
      (
        name: string,
        optionsOrCallback: { signal: AbortSignal } | (() => unknown),
        callback?: () => unknown,
      ) => {
        pending.add(name);
        const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;
        const run = callback ?? (optionsOrCallback as () => unknown);
        const result = (tails.get(name) ?? Promise.resolve()).then(async () => {
          pending.delete(name);
          if (options?.signal.aborted) throw new DOMException("Aborted", "AbortError");
          held.add(name);
          try {
            return await run();
          } finally {
            held.delete(name);
          }
        });
        tails.set(
          name,
          result.catch(() => {}),
        );
        return result;
      },
    ),
    query: async () => ({
      held: [...held].map((name) => ({ name })),
      pending: [...pending].map((name) => ({ name })),
    }),
  };
}

let focused = false;
let data: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  focused = false;
  data = new Map();
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      },
    }),
  );
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused }),
  );
  vi.stubGlobal("navigator", { locks: sharedLocks() });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("atomically claims a concurrent event once across independent renderers", async () => {
  const first = await import("./threadNotificationOwnership");
  vi.resetModules();
  const second = await import("./threadNotificationOwnership");
  expect(
    await Promise.all([
      first.claimThreadNotification("event"),
      second.claimThreadNotification("event"),
    ]),
  ).toEqual([true, false]);
  expect(await second.claimThreadNotification("different-event")).toBe(true);
});

it("uses native main ownership without browser locks or storage", async () => {
  const claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  Object.assign(window, { desktopBridge: { claimThreadNotification: claim } });
  const { claimThreadNotification, trackNotificationWindowFocus } =
    await import("./threadNotificationOwnership");
  const stop = trackNotificationWindowFocus();
  expect(await claimThreadNotification("event")).toBe(false);
  expect(await claimThreadNotification("next")).toBe(true);
  expect(claim).toHaveBeenCalledWith("event");
  expect(navigator.locks.request).not.toHaveBeenCalled();
  expect(data.size).toBe(0);
  stop();
});

it("does not bypass a failed native claim", async () => {
  Object.assign(window, {
    desktopBridge: {
      claimThreadNotification: vi.fn().mockRejectedValue(new Error("IPC disconnected")),
    },
  });
  const { claimThreadNotification } = await import("./threadNotificationOwnership");
  expect(await claimThreadNotification("event")).toBe(false);
  expect(navigator.locks.request).not.toHaveBeenCalled();
});

it("defers background delivery to a focused renderer even when it suppresses the viewed chat", async () => {
  const { claimThreadNotification, trackNotificationWindowFocus } =
    await import("./threadNotificationOwnership");
  focused = true;
  const stop = trackNotificationWindowFocus();
  focused = false; // The other renderer observes the same manager/storage, but has no focus.
  expect(await claimThreadNotification("viewed-event")).toBe(false);
  expect(data.size).toBe(0);
  focused = true;
  expect(await claimThreadNotification("other-thread-event")).toBe(true);
  window.dispatchEvent(new Event("blur"));
  focused = false;
  expect(await claimThreadNotification("background-event")).toBe(true);
  stop();
});

it("releases focus ownership on unmount/window teardown", async () => {
  const { claimThreadNotification, trackNotificationWindowFocus } =
    await import("./threadNotificationOwnership");
  focused = true;
  const stop = trackNotificationWindowFocus();
  stop();
  focused = false;
  expect(await claimThreadNotification("event")).toBe(true);
});

it("expires old claims and bounds the stored history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const { claimThreadNotification } = await import("./threadNotificationOwnership");
  expect(await claimThreadNotification("event")).toBe(true);
  vi.setSystemTime(1_120_001);
  expect(await claimThreadNotification("event")).toBe(true);
  for (let index = 0; index < 520; index++) await claimThreadNotification(String(index));
  expect(JSON.parse([...data.values()][0]!)).toHaveLength(512);
});

it("uses best-effort storage with a warning when Web Locks are unavailable", async () => {
  vi.stubGlobal("navigator", {});
  const { claimThreadNotification } = await import("./threadNotificationOwnership");
  expect(await claimThreadNotification("event")).toBe(true);
  expect(await claimThreadNotification("event")).toBe(false);
  expect(console.warn).toHaveBeenCalledOnce();
});

it("survives blocked storage and deduplicates locally without claiming cross-window guarantees", async () => {
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new Error("blocked");
    },
  });
  const { claimThreadNotification } = await import("./threadNotificationOwnership");
  expect(await claimThreadNotification("event")).toBe(true);
  expect(await claimThreadNotification("event")).toBe(false);
  expect(console.warn).toHaveBeenCalledOnce();
});

it("retains local claims when storage reads succeed but writes fail", async () => {
  Object.assign(window, {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
  });
  const { claimThreadNotification } = await import("./threadNotificationOwnership");
  expect(await claimThreadNotification("event")).toBe(true);
  expect(await claimThreadNotification("event")).toBe(false);
  expect(console.warn).toHaveBeenCalledOnce();
});
