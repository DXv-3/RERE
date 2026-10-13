import { Image, type ColorValue } from "react-native";
import { withUniwind } from "uniwind";

const ThemedImage = withUniwind(Image);

// The monochrome claw mark, white on transparent so it can take the surrounding text color.
const CLAW_MARK_SOURCE = require("../../assets/android-icon-mark.png");

/**
 * The CodeWrench claw, shown where the app marks its own tools. The component keeps its original
 * name because other files import it; it no longer draws the upstream "T3" letters.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <ThemedImage
      accessibilityLabel="CodeWrench"
      accessibilityIgnoresInvertColors
      source={CLAW_MARK_SOURCE}
      resizeMode="contain"
      style={{ height: props.height * 1.6, width: props.height * 1.6 }}
      {...(props.colorClassName
        ? { tintColorClassName: props.colorClassName }
        : { tintColor: props.color })}
    />
  );
}
