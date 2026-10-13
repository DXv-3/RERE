import * as NodeCrypto from "node:crypto";

import { DevicePushRegistration, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { isDeadApnsToken, makeApnsProviderToken } from "./apns.ts";
import * as DateTime from "effect/DateTime";

import {
  apnsPayloadForState,
  badgeCountForShells,
  notificationAllowed,
  shouldNotifyPhaseChange,
} from "./DevicePush.ts";

const allOn = {
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

describe("shouldNotifyPhaseChange", () => {
  it("stays quiet for a thread seen for the first time", () => {
    expect(shouldNotifyPhaseChange(undefined, "completed")).toBe(false);
    expect(shouldNotifyPhaseChange(undefined, "waiting_for_approval")).toBe(false);
  });

  it("notifies when a running thread finishes, fails or needs the user", () => {
    expect(shouldNotifyPhaseChange("running", "completed")).toBe(true);
    expect(shouldNotifyPhaseChange("running", "failed")).toBe(true);
    expect(shouldNotifyPhaseChange("running", "waiting_for_approval")).toBe(true);
    expect(shouldNotifyPhaseChange("waiting_for_approval", "waiting_for_input")).toBe(true);
  });

  it("does not repeat a notification for an unchanged or already finished thread", () => {
    expect(shouldNotifyPhaseChange("completed", "completed")).toBe(false);
    expect(shouldNotifyPhaseChange("failed", "completed")).toBe(false);
    expect(shouldNotifyPhaseChange("waiting_for_input", "running")).toBe(false);
  });
});

describe("notificationAllowed", () => {
  it("follows the device's per-event switches", () => {
    expect(notificationAllowed(allOn, "completed")).toBe(true);
    expect(notificationAllowed({ ...allOn, notifyOnCompletion: false }, "completed")).toBe(false);
    expect(notificationAllowed({ ...allOn, notificationsEnabled: false }, "failed")).toBe(false);
    expect(notificationAllowed(allOn, "running")).toBe(false);
  });
});

describe("notificationAllowed run length", () => {
  it.each([
    ["a 5 second reply", allOn, 5, false],
    ["just under the default minute", allOn, 59.9, false],
    ["exactly the default minute", allOn, 60, true],
    ["a 3 minute run", allOn, 180, true],
    ["an unknown length", allOn, null, true],
    ["a short reply when every completion is wanted", { ...allOn, minRunSeconds: 0 }, 5, true],
    ["under a 3 minute setting", { ...allOn, minRunSeconds: 180 }, 179, false],
    ["exactly a 3 minute setting", { ...allOn, minRunSeconds: 180 }, 180, true],
  ] as const)("completed after %s", (_name, preferences, seconds, allowed) => {
    expect(notificationAllowed(preferences, "completed", seconds)).toBe(allowed);
  });

  it.each(["waiting_for_input", "waiting_for_approval", "failed"] as const)(
    "never holds back %s for being quick",
    (phase) => {
      expect(notificationAllowed({ ...allOn, minRunSeconds: 600 }, phase, 1)).toBe(true);
    },
  );

  it("still honours the per-event switch before the run length", () => {
    expect(notificationAllowed({ ...allOn, notifyOnCompletion: false }, "completed", 900)).toBe(
      false,
    );
  });
});

describe("DevicePushRegistration preferences", () => {
  const registration = {
    deviceId: "device-1",
    label: "Phone",
    platform: "ios",
    bundleId: "net.example.app",
    apsEnvironment: "production",
    pushToken: "token",
  };
  const decode = Schema.decodeUnknownSync(DevicePushRegistration);

  it("accepts the preferences an installed phone build sends, without a minimum run", () => {
    const decoded = decode({ ...registration, preferences: allOn });
    expect(decoded.preferences.minRunSeconds).toBeUndefined();
    expect(notificationAllowed(decoded.preferences, "completed", 5)).toBe(false);
  });

  it("carries the minimum run when a newer build sends it", () => {
    const decoded = decode({ ...registration, preferences: { ...allOn, minRunSeconds: 0 } });
    expect(decoded.preferences.minRunSeconds).toBe(0);
    expect(notificationAllowed(decoded.preferences, "completed", 5)).toBe(true);
  });

  it("rejects a negative minimum run", () => {
    expect(() =>
      decode({ ...registration, preferences: { ...allOn, minRunSeconds: -1 } }),
    ).toThrow();
  });
});

describe("apnsPayloadForState", () => {
  const state = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    projectTitle: "workbench",
    threadTitle: "Fix the build",
    phase: "completed" as const,
    headline: "Finished",
    detail: "The build passes again after the lockfile change.",
    modelTitle: "Claude",
    updatedAt: "2026-10-04T15:00:00.000Z",
    deepLink: "/threads/env-1/thread-1",
  };

  it("names the conversation, what happened, and what the agent said", () => {
    const payload = apnsPayloadForState(state);
    expect(payload.aps.alert).toEqual({
      title: "Fix the build",
      subtitle: "Finished · workbench",
      body: "The build passes again after the lockfile change.",
    });
  });

  it("sets the icon number only when the server could count", () => {
    expect(apnsPayloadForState(state, 3).aps.badge).toBe(3);
    expect(apnsPayloadForState(state, 0).aps.badge).toBe(0);
    expect("badge" in apnsPayloadForState(state).aps).toBe(false);
  });

  it("puts the keys a tap needs under body, where the app reads them", () => {
    expect(apnsPayloadForState(state).body).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("leaves the project out when it only repeats the thread title", () => {
    expect(
      apnsPayloadForState({ ...state, projectTitle: "fix the build" }).aps.alert.subtitle,
    ).toBe("Finished");
  });

  it("never ends the subtitle on a separator or produces an empty body", () => {
    const alert = apnsPayloadForState({
      ...state,
      headline: "Needs approval",
      phase: "waiting_for_approval",
      detail: undefined,
    }).aps.alert;
    expect(alert.subtitle).toBe("Needs approval · workbench");
    expect(alert.body).toBe("Needs approval");
  });
});

describe("apns", () => {
  it("signs a provider token Apple's ES256 check accepts", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const token = makeApnsProviderToken(
      {
        teamId: "TEAM123456",
        keyId: "KEY1234567",
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      1_800_000_000,
    );
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_800_000_000,
    });
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("treats only permanent token rejections as a dead device", () => {
    expect(isDeadApnsToken({ ok: false, status: 410, reason: "Unregistered" })).toBe(true);
    expect(isDeadApnsToken({ ok: false, status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadApnsToken({ ok: false, status: 429, reason: "TooManyRequests" })).toBe(false);
    expect(isDeadApnsToken({ ok: true })).toBe(false);
  });
});

describe("badgeCountForShells", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const shell = (overrides: Record<string, unknown>) =>
    ({
      archivedAt: null,
      lineage: { relationshipToParent: null },
      settledOverride: null,
      snoozedUntil: null,
      pendingRuntimeRequest: null,
      status: "completed",
      latestRunCompletedAt: null,
      lastVisitedAt: null,
      ...overrides,
    }) as never;
  const now = Date.parse("2026-10-12T12:00:00.000Z");

  it("counts unread finishes, questions and failures, and skips what was put away", () => {
    const count = badgeCountForShells(
      [
        shell({
          latestRunCompletedAt: at("2026-10-12T11:00:00.000Z"),
          lastVisitedAt: at("2026-10-12T10:00:00.000Z"),
        }),
        shell({
          latestRunCompletedAt: at("2026-10-12T09:00:00.000Z"),
          lastVisitedAt: at("2026-10-12T10:00:00.000Z"),
        }),
        shell({ pendingRuntimeRequest: { kind: "approval" } }),
        shell({ status: "failed" }),
        shell({
          status: "failed",
          snoozedUntil: at("2026-10-13T00:00:00.000Z"),
        }),
        shell({ status: "failed", archivedAt: at("2026-10-11T00:00:00.000Z") }),
      ],
      now,
    );
    expect(count).toBe(3);
  });
});
