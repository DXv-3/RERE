import { describe, expect, it } from "vite-plus/test";
import {
  codewrenchPublishConfig,
  validateCodewrenchFeedUrl,
} from "./lib/codewrench-update-policy.ts";

describe("CodeWrench feed boundary", () => {
  it("requires a dedicated HTTPS location", () => {
    for (const url of [
      "http://updates.example.com/codewrench/mac/",
      "https://updates.t3.codes/codewrench/",
      "https://github.com/codewrench/",
      "https://user:secret@updates.example.com/codewrench/",
      "https://updates.example.com/latest/",
      "https://updates.example.com/codewrench/?token=secret",
      "https://updates.example.com/codewrench/#latest",
      "https://updates.example.com/codewrench/../t3/",
    ])
      expect(() => validateCodewrenchFeedUrl(url)).toThrow();
    expect(validateCodewrenchFeedUrl("https://updates.example.com/codewrench/mac")).toBe(
      "https://updates.example.com/codewrench/mac/",
    );
  });
  it("fails closed for unsigned, ad-hoc and non-Mac feed builds", () => {
    const feedUrl = "https://updates.example.com/codewrench/mac/";
    for (const identity of [undefined, "-", "Apple Development: Example (ABCDE12345)"]) {
      expect(() => codewrenchPublishConfig({ feedUrl, platform: "mac", identity })).toThrow();
    }
    const identity = "Developer ID Application: Example (ABCDE12345)";
    expect(() => codewrenchPublishConfig({ feedUrl, platform: "linux", identity })).toThrow();
    expect(codewrenchPublishConfig({ feedUrl, platform: "mac", identity })).toEqual({
      provider: "generic",
      url: feedUrl,
      channel: "latest",
    });
    expect(
      codewrenchPublishConfig({ feedUrl: undefined, platform: "mac", identity: "-" }),
    ).toBeUndefined();
  });
});
