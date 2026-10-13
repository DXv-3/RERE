import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { textMayOverflow } from "../agentGoalsLogic";

/** Text cut to `lines` lines with a Show More toggle, which only appears for text that may overflow. */
export function ClampedText(props: {
  readonly text: string;
  readonly lines?: number;
  readonly className?: string;
}) {
  const lines = props.lines ?? 6;
  const [expanded, setExpanded] = useState(false);
  const toggle = textMayOverflow(props.text, lines);
  return (
    <>
      <Text
        selectable
        className={props.className ?? "text-base text-foreground"}
        numberOfLines={expanded ? undefined : lines}
      >
        {props.text}
      </Text>
      {toggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((open) => !open)}
          className="min-h-11 justify-center self-start active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-primary-text">
            {expanded ? "Show Less" : "Show More"}
          </Text>
        </Pressable>
      ) : null}
    </>
  );
}
