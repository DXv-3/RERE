import type { MenuAction } from "@react-native-menu/menu";
import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, TextInput as RNTextInput, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ControlPillMenu } from "../../../components/ControlPill";
import { SegmentedControl } from "../../../components/SegmentedControl";
import type { ScheduleDraft } from "../scheduledTaskDraft";

const DAYS = [
  { index: 1, label: "Mon" },
  { index: 2, label: "Tue" },
  { index: 3, label: "Wed" },
  { index: 4, label: "Thu" },
  { index: 5, label: "Fri" },
  { index: 6, label: "Sat" },
  { index: 0, label: "Sun" },
] as const;

export function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return value;
  const time = new Date();
  time.setHours(hours ?? 9, minutes ?? 0, 0, 0);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function timePickerValue(value: string): Date {
  const [hours, minutes] = value.split(":").map(Number);
  const time = new Date();
  time.setHours(
    Number.isInteger(hours) ? (hours ?? 9) : 9,
    Number.isInteger(minutes) ? (minutes ?? 0) : 0,
    0,
    0,
  );
  return time;
}

export function repeatLabel(weekdays: ReadonlyArray<number>): string {
  const days = new Set(weekdays);
  if (days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return (
    DAYS.filter((day) => days.has(day.index))
      .map((day) => day.label)
      .join(", ") || "Choose days"
  );
}

export function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly keyboardType?: "decimal-pad";
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly borderTop?: boolean;
  readonly multiline?: boolean;
  readonly maxLength?: number;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <RNTextInput
        accessibilityLabel={props.label}
        value={props.value}
        readOnly={props.disabled}
        onChangeText={props.onChange}
        textAlignVertical={props.multiline ? "top" : "center"}
        keyboardType={props.keyboardType}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-foreground-muted"
        multiline={props.multiline}
        maxLength={props.maxLength}
        className={
          props.multiline
            ? "min-h-24 font-sans text-base text-foreground"
            : "min-h-8 font-sans text-base text-foreground"
        }
      />
    </View>
  );
}

export function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly valueIcon?: ReactNode;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
}) {
  const value = (
    <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
      {props.valueIcon}
      <Text className="shrink text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
  if (props.actions.length === 0) {
    return (
      <View
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
      </View>
    );
  }
  return (
    <ControlPillMenu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        }
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

export const SCHEDULE_TIME_ZONE_NOTE =
  "Time uses the environment's time zone, which may differ from your phone's.";

/**
 * The schedule rows shared by scheduled tasks and agent goals: At A Time or Every Interval, with
 * the time, repeat days and interval. Render inside a `SettingsSection`.
 */
export function ScheduleFields({
  schedule,
  onChange,
  disabled,
  intervalNotice,
}: {
  readonly schedule: ScheduleDraft;
  readonly onChange: (schedule: ScheduleDraft) => void;
  readonly disabled?: boolean;
  /** Extra line under the interval field, such as why an old interval cannot be kept. */
  readonly intervalNotice?: string | null;
}) {
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  return (
    <>
      <View className="px-4 py-3">
        <SegmentedControl
          options={[
            { value: "fixed_time", label: "At a time" },
            { value: "interval", label: "Every interval" },
          ]}
          selected={schedule.mode}
          onSelect={(mode) => {
            setTimePickerOpen(false);
            onChange({ ...schedule, mode });
          }}
        />
      </View>
      {schedule.mode === "fixed_time" ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Time, ${formatTime(schedule.timeOfDay)}`}
            onPress={() => setTimePickerOpen((open) => !open)}
            className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text className="text-lg text-foreground">Time</Text>
            <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted">
              {formatTime(schedule.timeOfDay)}
            </Text>
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
            />
          </Pressable>
          {timePickerOpen ? (
            <DateTimePicker
              value={timePickerValue(schedule.timeOfDay)}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onDismiss={() => setTimePickerOpen(false)}
              onValueChange={(_, selected) => {
                const timeOfDay = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
                onChange({ ...schedule, timeOfDay });
              }}
            />
          ) : null}
          <SelectRow
            label="Repeat"
            value={repeatLabel(schedule.weekdays)}
            borderTop
            actions={[
              {
                id: "every_day",
                title: "Every day",
                state: schedule.weekdays.length === 7 ? "on" : undefined,
              },
              {
                id: "weekdays",
                title: "Weekdays",
                state: repeatLabel(schedule.weekdays) === "Weekdays" ? "on" : undefined,
              },
              ...DAYS.map((day) => ({
                id: String(day.index),
                title: day.label,
                attributes: { keepsMenuPresented: true },
                state: schedule.weekdays.includes(day.index) ? ("on" as const) : undefined,
              })),
            ]}
            onSelect={(id) => {
              const weekdays =
                id === "every_day"
                  ? DAYS.map((day) => day.index)
                  : id === "weekdays"
                    ? [1, 2, 3, 4, 5]
                    : (() => {
                        const day = DAYS.find((item) => String(item.index) === id);
                        if (!day) return schedule.weekdays;
                        return schedule.weekdays.includes(day.index)
                          ? schedule.weekdays.filter((index) => index !== day.index)
                          : [...schedule.weekdays, day.index];
                      })();
              onChange({ ...schedule, weekdays });
            }}
          />
        </>
      ) : (
        <>
          <FormField
            label="Minutes between runs"
            value={schedule.intervalMinutes}
            keyboardType="decimal-pad"
            disabled={disabled}
            borderTop
            onChange={(intervalMinutes) => onChange({ ...schedule, intervalMinutes })}
          />
          {Number(schedule.intervalMinutes) < 1 ? (
            <Text className="px-4 pb-3 text-sm text-danger-foreground">
              Intervals must be at least 1 minute. Update this interval before saving.
            </Text>
          ) : intervalNotice ? (
            <Text className="px-4 pb-3 text-sm text-foreground-muted">{intervalNotice}</Text>
          ) : null}
        </>
      )}
    </>
  );
}
