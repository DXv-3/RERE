import {
  DEFAULT_NOTIFY_MIN_RUN_SECONDS,
  DEFAULT_NOTIFY_QUIET_HOURS_END,
  DEFAULT_NOTIFY_QUIET_HOURS_START,
  NOTIFY_MIN_RUN_SECONDS_CHOICES,
  type NotifyMinRunSeconds,
} from "@t3tools/contracts/settings";
import { parseClockMinutes } from "@t3tools/shared/threadNotificationPolicy";
import { useEffect, useState } from "react";

import {
  getSystemNotificationPermission,
  requestSystemNotificationPermission,
  SYSTEM_NOTIFICATION_PERMISSION_MESSAGES,
  type SystemNotificationPermission,
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODE_LABELS,
  unlockNotificationAudio,
  testNotificationDelivery,
} from "../../threadNotifications";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const NOTIFY_MIN_RUN_LABELS: Record<NotifyMinRunSeconds, string> = {
  0: "Any length",
  30: "30 s",
  60: "1 min",
  180: "3 min",
  600: "10 min",
};

export function NotificationSettings() {
  const [permission, setPermission] = useState(getSystemNotificationPermission);
  useEffect(() => {
    const refresh = () => {
      setPermission(getSystemNotificationPermission());
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return (
    <>
      <ThreadNotificationModeSetting permission={permission} onPermissionChange={setPermission} />
      <NotificationTestSetting
        onTestFinished={() => setPermission(getSystemNotificationPermission())}
      />
      <FinishedThreadsSetting />
      <QuietHoursSetting />
    </>
  );
}

function FinishedThreadsSetting() {
  const minRunSeconds = useScopedSettings((settings) => settings.notifyMinRunSeconds);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("finished-thread-notifications")}
      description="Notify when a run took at least this long. Questions, approvals, failures and usage limits always notify."
      resetAction={
        minRunSeconds !== DEFAULT_NOTIFY_MIN_RUN_SECONDS ? (
          <SettingResetButton
            label="finished thread notifications"
            onClick={() => updateSettings({ notifyMinRunSeconds: DEFAULT_NOTIFY_MIN_RUN_SECONDS })}
          />
        ) : null
      }
      control={
        <Select
          value={String(minRunSeconds)}
          onValueChange={(value) => {
            const seconds = NOTIFY_MIN_RUN_SECONDS_CHOICES.find(
              (choice) => String(choice) === value,
            );
            if (seconds !== undefined) updateSettings({ notifyMinRunSeconds: seconds });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Minimum run length">
            <SelectValue>{NOTIFY_MIN_RUN_LABELS[minRunSeconds]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {NOTIFY_MIN_RUN_SECONDS_CHOICES.map((choice) => (
              <SelectItem key={choice} hideIndicator value={String(choice)}>
                {NOTIFY_MIN_RUN_LABELS[choice]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function QuietHoursSetting() {
  const enabled = useScopedSettings((settings) => settings.notifyQuietHoursEnabled);
  const start = useScopedSettings((settings) => settings.notifyQuietHoursStart);
  const end = useScopedSettings((settings) => settings.notifyQuietHoursEnd);
  const updateSettings = useUpdateScopedSettings();
  const changed =
    enabled || start !== DEFAULT_NOTIFY_QUIET_HOURS_START || end !== DEFAULT_NOTIFY_QUIET_HOURS_END;
  return (
    <SettingsRow
      {...searchableSetting("notification-quiet-hours")}
      description="Finished threads stay silent on this device between these times, in this device's local time. Questions, approvals, failures and usage limits still notify. Phone notifications don't use quiet hours."
      resetAction={
        changed ? (
          <SettingResetButton
            label="quiet hours"
            onClick={() =>
              updateSettings({
                notifyQuietHoursEnabled: false,
                notifyQuietHoursStart: DEFAULT_NOTIFY_QUIET_HOURS_START,
                notifyQuietHoursEnd: DEFAULT_NOTIFY_QUIET_HOURS_END,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          {enabled ? (
            <>
              <QuietHoursTime
                label="Quiet hours start"
                value={start}
                onCommit={(value) => updateSettings({ notifyQuietHoursStart: value })}
              />
              <span aria-hidden className="text-muted-foreground text-xs">
                to
              </span>
              <QuietHoursTime
                label="Quiet hours end"
                value={end}
                onCommit={(value) => updateSettings({ notifyQuietHoursEnd: value })}
              />
            </>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ notifyQuietHoursEnabled: checked })}
            aria-label="Quiet hours"
          />
        </div>
      }
    />
  );
}

function QuietHoursTime({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <Input
      size="sm"
      type="time"
      className="w-28"
      aria-label={label}
      value={value}
      onChange={(event) => {
        // A cleared or half-typed time is not a time yet; keep the saved one.
        if (parseClockMinutes(event.target.value) !== null) onCommit(event.target.value);
      }}
    />
  );
}

function ThreadNotificationModeSetting({
  permission,
  onPermissionChange,
}: {
  permission: SystemNotificationPermission;
  onPermissionChange: (permission: SystemNotificationPermission) => void;
}) {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={
        <span role="status">
          {mode === "sound"
            ? "Sound only plays audio; it does not send system banners. Choose a system banner mode for alerts while another window is focused."
            : mode === "off"
              ? "System banners and sound are off. In-app notifications are controlled separately."
              : "System banners appear while CodeWrench is open and its window is not focused. In-app notifications are controlled separately."}{" "}
          {SYSTEM_NOTIFICATION_PERMISSION_MESSAGES[permission]}
        </span>
      }
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              setRequesting(true);
              try {
                const nextPermission = await requestSystemNotificationPermission();
                onPermissionChange(nextPermission);
                if (nextPermission !== "granted") {
                  return;
                }
              } finally {
                setRequesting(false);
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Thread notifications">
            <SelectValue>{NOTIFICATION_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(NOTIFICATION_MODE_LABELS).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function NotificationTestSetting({ onTestFinished }: { onTestFinished: () => void }) {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <SettingsRow
      title="Test notifications"
      description={
        <span role="status">
          {result ??
            "Send a test with this device’s selected banner and sound settings. This test ignores quiet hours and minimum run length."}
        </span>
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={testing || mode === "off"}
          onClick={async () => {
            setTesting(true);
            try {
              let deliveryError: string | null = null;
              const result = await testNotificationDelivery(mode, (message) => {
                deliveryError = message;
                setResult(message);
              });
              setResult(deliveryError ?? result);
            } finally {
              setTesting(false);
              onTestFinished();
            }
          }}
        >
          {testing ? "Testing…" : "Send test"}
        </Button>
      }
    />
  );
}
