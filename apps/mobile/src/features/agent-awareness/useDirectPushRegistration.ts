import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_NOTIFY_MIN_RUN_SECONDS } from "@t3tools/contracts/settings";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { mobilePreferencesAtom } from "../../state/preferences";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { supportsDirectPush, syncDirectPushRegistration } from "./directRegistration";

/**
 * Keeps this phone registered with each connected server for notifications
 * when the app is not using CodeWrench Connect. Re-registers when a server connects,
 * the switch changes, the app returns to the foreground, or iOS rotates the token.
 */
export function useDirectPushRegistration() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.deviceNotificationsEnabled === true;
  const preferencesReady = AsyncResult.isSuccess(preferences);
  const minRunSeconds = AsyncResult.isSuccess(preferences)
    ? (preferences.value.notifyMinRunSeconds ?? DEFAULT_NOTIFY_MIN_RUN_SECONDS)
    : DEFAULT_NOTIFY_MIN_RUN_SECONDS;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connectedKey = connectedEnvironments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
  // Keyed by the joined ids so an unrelated projection update does not re-register.
  const environmentIds = useMemo(
    () => (connectedKey ? connectedKey.split("\n").map((id) => EnvironmentId.make(id)) : []),
    [connectedKey],
  );

  useEffect(() => {
    if (hasCloudPublicConfig() || !supportsDirectPush() || !preferencesReady) return;
    const run = () => void syncDirectPushRegistration({ environmentIds, enabled, minRunSeconds });
    run();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    const tokens = Notifications.addPushTokenListener(run);
    return () => {
      appState.remove();
      tokens.remove();
    };
  }, [enabled, environmentIds, minRunSeconds, preferencesReady]);
}
