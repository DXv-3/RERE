import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(["codewrench://", "codewrench:///", "codewrench-dev://", "codewrench-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );

  it.each([
    "codewrench://threads/env-1/thread-1",
    "codewrench://pair?pairingUrl=x",
    "codewrench-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "codewrench://expo-development-client/?url=x",
    "codewrench://expo-sharing/anything",
    "codewrench-dev://account-callback?code=c&state=s",
  ])("ignores lifecycle URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
