import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

const TONE = {
  primary: ["bg-primary", "text-primary-foreground"],
  neutral: ["bg-subtle", "text-foreground"],
  danger: ["bg-subtle", "text-danger-foreground"],
} as const;

/** A compact pill button with a 44pt touch target, for actions repeated down a list. */
export function ActionButton(props: {
  readonly label: string;
  /** Read aloud instead of `label` when the bare label would be ambiguous in a list. */
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: keyof typeof TONE;
}) {
  const [container, label] = TONE[props.tone ?? "neutral"];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "min-h-11 items-center justify-center rounded-full px-4 active:opacity-70 disabled:opacity-50",
        container,
      )}
    >
      <Text className={cn("text-sm font-t3-medium", label)}>{props.label}</Text>
    </Pressable>
  );
}
