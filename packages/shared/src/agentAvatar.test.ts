import { describe, expect, it } from "vite-plus/test";

import { grokBotAvatar } from "./agentAvatar.ts";

describe("grokBotAvatar", () => {
  it("rebuilds the bot face from the exported color and shape names", () => {
    expect(grokBotAvatar({ avatarColor: "magenta", avatarShape: "tablet" })).toEqual({
      kind: "bot",
      shape: "tablet",
      color: "#e51b94",
      icon: "bot",
      image: null,
    });
  });

  it("defaults the half that is missing or unknown", () => {
    expect(grokBotAvatar({ avatarColor: "gray", avatarShape: "starfish" })).toMatchObject({
      shape: "squircle",
      color: "#898989",
    });
    expect(grokBotAvatar({ avatarShape: "hex" })).toMatchObject({ shape: "hex", color: "#8054e6" });
  });

  it("returns nothing when the export names neither", () => {
    expect(grokBotAvatar({})).toBeNull();
    expect(grokBotAvatar({ avatarColor: "", avatarShape: "" })).toBeNull();
  });
});
