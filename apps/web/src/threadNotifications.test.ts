import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const start = vi.fn();
const requestPermission = vi.fn();
const banner = vi.fn();
let audioRunning = true;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  audioRunning = true;
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal(
    "Notification",
    class {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      addEventListener = vi.fn();
      constructor(...args: unknown[]) {
        banner(...args);
      }
    },
  );
  requestPermission.mockResolvedValue("granted");
  vi.stubGlobal(
    "AudioContext",
    class {
      get state() {
        return audioRunning ? "running" : "suspended";
      }
      resume() {
        return Promise.resolve();
      }
      decodeAudioData() {
        return Promise.resolve({});
      }
      destination = {};
      createBufferSource() {
        return { buffer: null, connect: vi.fn(), start };
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) }),
  );
});

describe("notification delivery test", () => {
  it("tests both selected channels and reports attempted delivery honestly", async () => {
    const { testNotificationDelivery } = await import("./threadNotifications");
    const result = await testNotificationDelivery("notifications-and-sound");
    expect(banner).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(result).toContain("banner requested");
    expect(result).toContain("sound started");
  });
  it("still tests sound when notification permission is denied", async () => {
    requestPermission.mockResolvedValue("denied");
    const { testNotificationDelivery } = await import("./threadNotifications");
    const result = await testNotificationDelivery("notifications-and-sound");
    expect(result).toContain("blocked");
    expect(banner).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });
  it("reports blocked audio without claiming playback", async () => {
    audioRunning = false;
    const { testNotificationDelivery } = await import("./threadNotifications");
    expect(await testNotificationDelivery("sound")).toContain("could not play");
    expect(start).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("does not request channels that are disabled", async () => {
    const { testNotificationDelivery } = await import("./threadNotifications");
    expect(await testNotificationDelivery("off")).toContain("Choose");
    expect(banner).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await testNotificationDelivery("notifications");
    expect(banner).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("system notification permission", () => {
  it.each(["granted", "denied"] as const)(
    "does not re-prompt when permission is %s",
    async (permission) => {
      Object.defineProperty(Notification, "permission", { value: permission, configurable: true });
      const { requestSystemNotificationPermission } = await import("./threadNotifications");
      expect(await requestSystemNotificationPermission()).toBe(permission);
      expect(requestPermission).not.toHaveBeenCalled();
    },
  );

  it("requests permission immediately from the gesture", async () => {
    const { requestSystemNotificationPermission } = await import("./threadNotifications");
    const pending = requestSystemNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(await pending).toBe("granted");
  });

  it.each(["throw", "reject"])(
    "keeps sound testing when permission requests %s",
    async (failure) => {
      if (failure === "throw")
        requestPermission.mockImplementation(() => {
          throw new Error("unsupported");
        });
      else requestPermission.mockRejectedValue(new Error("unsupported"));
      const { testNotificationDelivery } = await import("./threadNotifications");
      const result = await testNotificationDelivery("notifications-and-sound");
      expect(result).toContain("supported secure browser");
      expect(start).toHaveBeenCalledOnce();
      expect(banner).not.toHaveBeenCalled();
    },
  );

  it("does not prompt in an insecure context", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    const { requestSystemNotificationPermission } = await import("./threadNotifications");
    expect(await requestSystemNotificationPermission()).toBe("unavailable");
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("reports asynchronous banner failures without claiming delivery", async () => {
    const target = new EventTarget();
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        constructor() {
          return target;
        }
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onError = vi.fn();
    const { testNotificationDelivery } = await import("./threadNotifications");
    expect(await testNotificationDelivery("notifications", onError)).toContain("banner requested");
    target.dispatchEvent(new Event("error"));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("could not be delivered"));
    expect(warn).toHaveBeenCalledOnce();
  });
});
