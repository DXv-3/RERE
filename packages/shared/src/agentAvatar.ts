import type { AgentAvatar as Avatar } from "@t3tools/contracts";
export const agentAvatarShapes: Record<Avatar["shape"], string> = {
  circle: "M32 3a29 29 0 1 1 0 58a29 29 0 1 1 0-58",
  squircle: "M17 4Q4 5 4 19L5 46Q6 60 21 60L46 58Q60 57 59 42L57 17Q56 3 41 3Z",
  cloud:
    "M14 13Q4 11 5 24Q-1 32 6 40Q1 51 14 54Q20 65 31 58Q43 63 49 53Q61 53 60 40Q67 29 56 22Q57 8 44 10Q34-1 26 8Q17 3 14 13Z",
  hex: "M21 3Q17 3 14 8L3 28Q1 32 4 37L18 57Q21 61 26 60L48 57Q52 56 55 51L62 30Q63 26 60 22L43 5Q40 2 35 2Z",
  teardrop: "M9 57Q1 51 6 35L18 7Q23-2 33 5L56 24Q68 37 54 49L29 60Q17 65 9 57Z",
  wedge: "M8 7Q15-1 26 7L58 27Q67 34 58 43L31 60Q18 67 12 52L4 23Q1 12 8 7Z",
  blob: "M8 13Q14 3 27 6Q42-1 52 9Q65 16 58 29Q65 43 54 51Q46 63 33 58Q20 65 10 53Q-1 47 5 33Q-1 22 8 13Z",
  tablet: "M19 9L41 5Q56 3 60 19L63 36Q63 50 48 54L25 60Q8 62 4 47L1 29Q-1 14 19 9Z",
  pebble: "M8 17Q19 1 39 4Q59 5 61 26Q67 42 48 54Q31 65 13 56Q-3 47 3 30Z",
};

export const agentIconPaths = {
  bot: "M12 8V4H9M6 8h12a2 2 0 0 1 2 2v9H4v-9a2 2 0 0 1 2-2ZM8 12v3m8-3v3M1 12v4m22-4v4",
  briefcase: "M8 6V3h8v3M3 6h18v15H3ZM3 11h18M10 11v3h4v-3",
  code: "m8 5-7 7 7 7m8-14 7 7-7 7M14 3l-4 18",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20ZM2 12h20M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z",
  heart:
    "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
  megaphone: "M3 9h5l12-5v16L8 15H3ZM8 15l2 6H6l-2-6M23 9v6",
  palette:
    "M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4 2 2 0 0 1 0-4h4a3 3 0 0 0 3-3c0-4-4-7-9-7ZM7 9h.01M12 6h.01M17 9h.01M6 14h.01",
  shield: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z",
  sparkles: "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3ZM3 2v4M1 4h4m16 14v4m-2-2h4",
} as const;
export function agentForeground(color: string): string {
  const hex = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#111111";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r ?? 0) * 0.299 + (g ?? 0) * 0.587 + (b ?? 0) * 0.114 < 85 ? "#ffffff" : "#111111";
}

/** Grok Bot's named avatar colors. */
export const grokBotColors: Readonly<Record<string, string>> = {
  green: "#22c55e",
  blue: "#3b82f6",
  pink: "#ec4899",
  purple: "#a78bfa",
  orange: "#f97316",
  teal: "#14b8a6",
  red: "#ef1840",
  violet: "#8054e6",
  magenta: "#e51b94",
  cyan: "#08b5aa",
  black: "#343434",
  brown: "#98694b",
  gray: "#898989",
  white: "#eeeeee",
};

/**
 * The bot-face avatar Grok Bot showed for an agent, from the color and shape
 * names its export records. Null when the export names neither, so callers keep
 * their own default.
 */
export function grokBotAvatar(source: {
  readonly avatarColor?: unknown;
  readonly avatarShape?: unknown;
}): Avatar | null {
  const color = typeof source.avatarColor === "string" ? grokBotColors[source.avatarColor] : null;
  const shape =
    typeof source.avatarShape === "string" && Object.hasOwn(agentAvatarShapes, source.avatarShape)
      ? (source.avatarShape as Avatar["shape"])
      : null;
  if (!color && !shape) return null;
  return {
    kind: "bot",
    shape: shape ?? "squircle",
    color: color ?? "#8054e6",
    icon: "bot",
    image: null,
  };
}
