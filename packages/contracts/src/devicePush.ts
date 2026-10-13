import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayAgentAwarenessPreferences, RelayApnsEnvironment } from "./relay.ts";

/**
 * A phone registered with one environment for agent notifications. The
 * environment sends pushes itself, so the pairing session is the only login.
 */
export const DevicePushRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: Schema.Literals(["ios", "android"]),
  // The APNs topic is the app's bundle id, which differs per build variant, and
  // development-signed builds receive sandbox tokens.
  bundleId: TrimmedNonEmptyString,
  apsEnvironment: RelayApnsEnvironment,
  pushToken: TrimmedNonEmptyString,
  preferences: RelayAgentAwarenessPreferences,
});
export type DevicePushRegistration = typeof DevicePushRegistration.Type;

export const DevicePushUnregisterInput = Schema.Struct({ deviceId: TrimmedNonEmptyString });
export type DevicePushUnregisterInput = typeof DevicePushUnregisterInput.Type;

/** Which platforms this environment holds push credentials for. */
export const DevicePushStatus = Schema.Struct({
  ios: Schema.Boolean,
  android: Schema.Boolean,
});
export type DevicePushStatus = typeof DevicePushStatus.Type;

export class DevicePushError extends Schema.TaggedError<DevicePushError>()("DevicePushError", {
  reason: Schema.Literals(["storage", "not_configured"]),
}) {}
