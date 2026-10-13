import {
  DEFAULT_NOTIFY_MIN_RUN_SECONDS,
  NOTIFY_MIN_RUN_SECONDS_CHOICES,
  type NotifyMinRunSeconds,
} from "@t3tools/contracts/settings";

import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const LABELS: Record<NotifyMinRunSeconds, string> = {
  0: "Any length",
  30: "30 seconds",
  60: "1 minute",
  180: "3 minutes",
  600: "10 minutes",
};

/** How long a run must take before finishing it notifies this phone. */
export function FinishedThreadsSetting(props: {
  readonly value: NotifyMinRunSeconds | undefined;
  readonly disabled: boolean;
  readonly onChange: (seconds: NotifyMinRunSeconds) => void;
}) {
  const selected = props.value ?? DEFAULT_NOTIFY_MIN_RUN_SECONDS;
  return (
    <SettingsSection title="Finished threads">
      {NOTIFY_MIN_RUN_SECONDS_CHOICES.map((seconds, index) => (
        <SettingsChoiceRow
          key={seconds}
          label={LABELS[seconds]}
          description={
            seconds === 0
              ? "Notify for every finished thread."
              : `Notify when a run took at least ${LABELS[seconds]}.`
          }
          selected={selected === seconds}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onChange(seconds)}
        />
      ))}
    </SettingsSection>
  );
}
