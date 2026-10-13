import type { DesktopDictationStatus } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { dictationEngineDescription } from "./DictationSettings.logic";

const status = (patch: Partial<DesktopDictationStatus>): DesktopDictationStatus => ({
  available: true,
  model: "",
  reason: null,
  ...patch,
});

it("describes the engine in use", () => {
  expect(dictationEngineDescription("auto", null)).toContain("Checking");
  expect(dictationEngineDescription("auto", status({}))).toContain("Whisper");
  expect(dictationEngineDescription("auto", status({ engine: "apple" }))).toContain(
    "built into your Mac",
  );
  expect(dictationEngineDescription("whisper", status({ engine: "whisper" }))).toContain(
    "one-time install",
  );
});

it("explains why Apple's engine is not used when it was wanted", () => {
  const text = dictationEngineDescription("apple", status({ engine: "whisper" }));
  expect(text).toContain("not available here");
  expect(text).toContain("so dictation uses Whisper");
});
