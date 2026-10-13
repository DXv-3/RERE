import { Image } from "react-native";
import Svg, { Path, G, Rect, Text as SvgText } from "react-native-svg";
import type { WorkbenchAgentProfile } from "@t3tools/contracts";
import { agentAvatarShapes, agentIconPaths, agentForeground } from "@t3tools/shared/agentAvatar";
export function AgentAvatar({
  profile,
  size = 56,
}: {
  profile: WorkbenchAgentProfile;
  size?: number;
}) {
  const avatar = profile.avatar;
  const color = avatar?.color ?? profile.color;
  const foreground = agentForeground(color);
  if (avatar?.kind === "image" && avatar.image)
    return (
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: avatar.image }}
        style={{ width: size, height: size, borderRadius: size * 0.22 }}
      />
    );
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessible={false}>
      <Path d={agentAvatarShapes[avatar?.shape ?? "squircle"]} fill={color} />
      {avatar?.kind === "bot" ? (
        <G fill={foreground} rotation={-17} origin="32,32">
          <Rect x="22" y="23" width="6" height="15" rx="3" />
          <Rect x="36" y="23" width="6" height="15" rx="3" />
        </G>
      ) : avatar?.kind === "icon" ? (
        <G
          transform="translate(17 17) scale(1.25)"
          stroke={foreground}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <Path
            d={agentIconPaths[avatar.icon as keyof typeof agentIconPaths] ?? agentIconPaths.bot}
          />
        </G>
      ) : (
        <SvgText
          x="32"
          y="39"
          textAnchor="middle"
          fill={foreground}
          fontSize="18"
          fontWeight="bold"
        >
          {profile.name.slice(0, 2).toUpperCase()}
        </SvgText>
      )}
    </Svg>
  );
}
