import { describe, expect, it } from "vite-plus/test";

import { enginePostType } from "./enginePostType.ts";

describe("enginePostType", () => {
  it("calls image media an image on every platform", () => {
    for (const platform of ["instagram", "facebook", "tiktok", "pinterest"] as const) {
      expect(enginePostType(platform, ["https://cdn.test/a.PNG?x=1"])).toBe("image");
    }
  });

  it("calls video a reel on instagram and tiktok and a video elsewhere", () => {
    const urls = ["https://cdn.test/clip.mp4?sig=abc"];
    expect(enginePostType("instagram", urls)).toBe("reel");
    expect(enginePostType("tiktok", urls)).toBe("reel");
    expect(enginePostType("youtube", urls)).toBe("video");
    expect(enginePostType("facebook", urls)).toBe("video");
  });

  it("treats a mix that includes a video as video, and no media as text", () => {
    expect(enginePostType("linkedin", ["https://cdn.test/a.jpg", "https://cdn.test/b.mov"])).toBe(
      "video",
    );
    expect(enginePostType("gbp", [])).toBe("text");
  });
});
