import { describe, expect, it } from "vite-plus/test";

import { createThumbnailCache, frameDataUrl, thumbnailKey } from "./mediaThumbnail.logic";

describe("thumbnailKey", () => {
  it("differs by environment, folder and file", () => {
    const base = { environmentId: "e1", cwd: "/work/a", relativePath: "reel.mp4" };
    const keys = new Set([
      thumbnailKey(base),
      thumbnailKey({ ...base, environmentId: "e2" }),
      thumbnailKey({ ...base, cwd: "/work/b" }),
      thumbnailKey({ ...base, relativePath: "other.mp4" }),
    ]);
    expect(keys.size).toBe(4);
  });
  it("is stable for the same file, and cannot be fooled by separators in the names", () => {
    const a = { environmentId: "e1", cwd: "/w", relativePath: "x.mp4" };
    expect(thumbnailKey(a)).toBe(thumbnailKey({ ...a }));
    expect(thumbnailKey({ environmentId: "a|b", cwd: "c", relativePath: "d" })).not.toBe(
      thumbnailKey({ environmentId: "a", cwd: "b|c", relativePath: "d" }),
    );
  });
});

describe("createThumbnailCache", () => {
  it("keeps a frame", () => {
    const cache = createThumbnailCache();
    cache.setReady("k", "data:x");
    expect(cache.get("k", 1_000_000)).toEqual({ state: "ready", src: "data:x" });
  });

  it("remembers a failure briefly, then lets the file be tried again", () => {
    const cache = createThumbnailCache(10, 1_000);
    cache.setFailed("k", 100);
    expect(cache.get("k", 600)).toEqual({ state: "failed", at: 100 });
    expect(cache.get("k", 1_100)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("drops the oldest entry past its limit", () => {
    const cache = createThumbnailCache(2);
    cache.setReady("a", "1");
    cache.setReady("b", "2");
    cache.setReady("c", "3");
    expect(cache.get("a", 0)).toBeUndefined();
    expect(cache.get("b", 0)).toBeDefined();
    expect(cache.get("c", 0)).toBeDefined();
  });

  it("replaces a failure with a frame", () => {
    const cache = createThumbnailCache();
    cache.setFailed("k", 0);
    cache.setReady("k", "data:y");
    expect(cache.get("k", 1)).toEqual({ state: "ready", src: "data:y" });
    expect(cache.size()).toBe(1);
  });
});

describe("frameDataUrl", () => {
  it("builds an image address", () => {
    expect(frameDataUrl({ mimeType: "image/jpeg", base64: "AAA" })).toBe(
      "data:image/jpeg;base64,AAA",
    );
  });
});
