import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useSyncExternalStore } from "react";
import { Alert, Linking } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  getDirectPushStatus,
  subscribeDirectPushStatus,
  supportsDirectPush,
  type DirectPushStatus,
} from "../agent-awareness/directRegistration";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { FinishedThreadsSetting } from "./components/FinishedThreadsSetting";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const STATUS_SUBTITLE: Record<DirectPushStatus, string> = {
  off: "Get notified when an agent needs you, finishes or fails",
  pending: "Waiting for a server to connect",
  registered: "On for your connected servers",
  unavailable: "Your servers are not set up to send notifications",
  failed: "This device could not be registered. Try again",
};

/**
 * Notifications sent by the paired servers themselves. Used when the app is
 * built without CodeWrench Connect, where the pairing is the only account.
 */
export function DirectNotificationsSettings() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const status = useSyncExternalStore(
    subscribeDirectPushStatus,
    getDirectPushStatus,
    (): DirectPushStatus => "off",
  );
  const supported = supportsDirectPush();
  const wanted =
    AsyncResult.isSuccess(preferences) && preferences.value.deviceNotificationsEnabled === true;

  const onChange = async (enabled: boolean) => {
    if (!enabled) {
      savePreferences({ deviceNotificationsEnabled: false });
      return;
    }
    const permission = await runtime
      .runPromise(requestAgentNotificationPermission)
      .catch(() => ({ type: "unsupported" as const }));
    if (permission.type === "granted") {
      savePreferences({ deviceNotificationsEnabled: true });
      return;
    }
    Alert.alert(
      "Notifications Are Off",
      "Allow notifications for CodeWrench in system Settings, then turn this on again.",
      [
        { text: "Not Now", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={!supported || !AsyncResult.isSuccess(preferences)}
            subtitle={
              supported
                ? STATUS_SUBTITLE[wanted ? status : "off"]
                : "Available on iPhone in this app build"
            }
            value={supported && wanted && status !== "unavailable" && status !== "failed"}
            onValueChange={(enabled) => void onChange(enabled)}
          />
        </SettingsSection>
        <FinishedThreadsSetting
          value={
            AsyncResult.isSuccess(preferences) ? preferences.value.notifyMinRunSeconds : undefined
          }
          disabled={!AsyncResult.isSuccess(preferences)}
          onChange={(seconds) => savePreferences({ notifyMinRunSeconds: seconds })}
        />
        <Text className="px-2 text-sm text-foreground-muted">
          Questions, approvals, failures and usage limits always notify.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
