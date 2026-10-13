import { expect, it } from "vite-plus/test";
import {
  classifyNativeSpeechError,
  nativeSpeechErrorText,
  parseNativeSpeechError,
} from "./appleDictation";

it("reads the helper's error code from the front of a message", () => {
  expect(parseNativeSpeechError("[permission_denied] Turn it on.")).toEqual({
    code: "permission_denied",
    message: "Turn it on.",
  });
  expect(parseNativeSpeechError("Something else")).toEqual({
    code: "unknown",
    message: "Something else",
  });
});

it("only unavailable errors may fall back to Whisper", () => {
  for (const code of ["helper_missing", "on_device_unavailable", "unsupported_os"]) {
    expect(classifyNativeSpeechError(code)).toBe("unavailable");
  }
  expect(classifyNativeSpeechError("permission_denied")).toBe("permission");
  expect(classifyNativeSpeechError("audio_failed")).toBe("failed");
  expect(classifyNativeSpeechError("busy")).toBe("failed");
});

it("always explains where to fix a denied permission", () => {
  expect(nativeSpeechErrorText("permission_denied", "")).toContain("Speech Recognition");
  expect(nativeSpeechErrorText("audio_failed", "")).toBe("Speech recognition failed.");
});
