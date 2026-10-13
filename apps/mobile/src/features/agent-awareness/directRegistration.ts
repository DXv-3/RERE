import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DevicePushRegistration, EnvironmentId } from "@t3tools/contracts";

import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { supportsAgentAwarenessPush } from "./capabilities";
import { resolveApsEnvironment } from "./registrationPayload";

/**
 * Where this phone stands with the servers that send its notifications
 * themselves. `unavailable` means every connected server answered that it has
 * no push credentials.
 */
export type DirectPushStatus = "off" | "pending" | "registered" | "unavailable" | "failed";

let status: DirectPushStatus = "off";
const listeners = new Set<() => void>();
// The registration each server last accepted, so an unchanged launch sends nothing.
const acceptedByEnvironment = new Map<EnvironmentId, string>();
let queue: Promise<void> = Promise.resolve();

function setStatus(next: DirectPushStatus) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

export const getDirectPushStatus = () => status;
export function subscribeDirectPushStatus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Direct registration covers iPhone only; Android needs a Firebase project the servers do not have. */
export const supportsDirectPush = () => Platform.OS === "ios" && supportsAgentAwarenessPush();

async function readRegistration(minRunSeconds: number): Promise<DevicePushRegistration | null> {
  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) return null;
  const token = await Notifications.getDevicePushTokenAsync();
  const pushToken = token.type === "ios" && typeof token.data === "string" ? token.data.trim() : "";
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
  if (!pushToken || !bundleId) return null;
  return {
    deviceId: await loadOrCreateAgentAwarenessDeviceId(),
    label: Constants.deviceName?.trim() || "iOS device",
    platform: "ios",
    bundleId,
    apsEnvironment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
    pushToken,
    preferences: {
      liveActivitiesEnabled: false,
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
      minRunSeconds,
    },
  };
}

async function unregisterEverywhere() {
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  await Promise.all(
    [...acceptedByEnvironment.keys()].map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.devicePushUnregister,
        { environmentId, input: { deviceId } },
        { reportFailure: false, reportDefect: false },
      ),
    ),
  );
  acceptedByEnvironment.clear();
}

async function sync(
  environmentIds: ReadonlyArray<EnvironmentId>,
  enabled: boolean,
  minRunSeconds: number,
) {
  if (!supportsDirectPush()) return setStatus("off");
  if (!enabled) {
    await unregisterEverywhere();
    return setStatus("off");
  }
  const registration = await readRegistration(minRunSeconds);
  if (registration === null) return setStatus("off");
  if (environmentIds.length === 0) {
    return setStatus(acceptedByEnvironment.size > 0 ? "registered" : "pending");
  }
  const signature = JSON.stringify(registration);
  let unavailable = 0;
  let failed = 0;
  for (const environmentId of environmentIds) {
    if (acceptedByEnvironment.get(environmentId) === signature) continue;
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.devicePushRegister,
      { environmentId, input: registration },
      { reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Success") {
      acceptedByEnvironment.set(environmentId, signature);
      continue;
    }
    acceptedByEnvironment.delete(environmentId);
    const error = squashAtomCommandFailure(result);
    const notConfigured =
      typeof error === "object" &&
      error !== null &&
      "reason" in error &&
      error.reason === "not_configured";
    if (notConfigured) unavailable += 1;
    else failed += 1;
  }
  if (environmentIds.some((id) => acceptedByEnvironment.has(id))) return setStatus("registered");
  setStatus(failed === 0 && unavailable > 0 ? "unavailable" : "failed");
}

/**
 * Brings every connected server's record of this phone in line with the
 * current switch position, permission and push token. Calls run one at a time.
 */
export function syncDirectPushRegistration(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly enabled: boolean;
  /** Finished runs shorter than this stay silent on this phone. */
  readonly minRunSeconds: number;
}): Promise<void> {
  queue = queue
    .then(() => sync(input.environmentIds, input.enabled, input.minRunSeconds))
    .catch(() => setStatus("failed"));
  return queue;
}
