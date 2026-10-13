import type { ReactNode } from "react";

import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import type { ScheduleDraft } from "./scheduledTasksSettings.logic";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/**
 * Schedule inputs shared by scheduled tasks and agent goals: a fixed time on chosen days, or an
 * interval in minutes. `idPrefix` keeps the input ids unique when two forms can be open at once.
 */
export function ScheduleFields({
  value,
  onChange,
  idPrefix,
  notice,
}: {
  readonly value: ScheduleDraft;
  readonly onChange: (patch: Partial<ScheduleDraft>) => void;
  readonly idPrefix: string;
  /** Shown above the controls, such as a warning about a legacy value. */
  readonly notice?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {notice}
      <div className="flex items-center justify-between gap-2">
        <Label>Schedule</Label>
        <ToggleGroup
          aria-label="Schedule type"
          value={[value.scheduleMode]}
          onValueChange={(values) => {
            const mode = values[0];
            if (mode === "fixed" || mode === "interval") onChange({ scheduleMode: mode });
          }}
        >
          <Toggle value="fixed">At a time</Toggle>
          <Toggle value="interval">Every interval</Toggle>
        </ToggleGroup>
      </div>

      {value.scheduleMode === "fixed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${idPrefix}-time`}>Run at</Label>
            <Input
              type="time"
              id={`${idPrefix}-time`}
              nativeInput
              className="w-32"
              value={value.timeOfDay}
              onChange={(event) => onChange({ timeOfDay: event.target.value })}
            />
            <span className="text-xs text-muted-foreground">on</span>
          </div>
          <ToggleGroup
            multiple
            variant="outline"
            size="sm"
            aria-label="Days to run"
            value={[...value.weekdays].map(String)}
            onValueChange={(values) => {
              if (values.length === 0) return;
              onChange({ weekdays: new Set(values.map(Number)) });
            }}
          >
            {WEEKDAY_ORDER.map((day) => (
              <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                {WEEKDAY_SHORT[day]}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-interval`}>Run every</Label>
          <Input
            type="number"
            id={`${idPrefix}-interval`}
            nativeInput
            min={1}
            step="any"
            className="w-24"
            value={value.intervalMinutes}
            onChange={(event) => onChange({ intervalMinutes: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">minutes</span>
        </div>
      )}
    </div>
  );
}
