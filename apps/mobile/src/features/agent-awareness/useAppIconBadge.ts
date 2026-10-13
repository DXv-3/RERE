import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";

import { useThreadShells } from "../../state/entities";
import { appIconBadgeCount } from "./appIconBadge";

/**
 * Keeps the app icon's number in step with the thread list while the app runs. Alerts set it
 * while the app is closed; this lowers it as threads are read. iOS ignores the call when the
 * person has not allowed badges.
 */
export function useAppIconBadge() {
  const threads = useThreadShells();
  const count = appIconBadgeCount(threads, Date.now());
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void Notifications.setBadgeCountAsync(count).catch(() => undefined);
  }, [count]);
}
