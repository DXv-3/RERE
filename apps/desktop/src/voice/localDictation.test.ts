import { expect, it as plainIt } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import { describeModelFile } from "./dictationModels.ts";
import {
  inspectDictationTools,
  MAX_AUDIO_BYTES,
  missingToolsReason,
  validateRecording,
  whisperLanguage,
  whisperThreads,
} from "./localDictation.ts";
plainIt("rejects invalid and oversized recordings before launching tools", () => {
  expect(() => validateRecording(new Uint8Array())).toThrow();
  expect(() => validateRecording(new TextEncoder().encode("not audio at all"))).toThrow();
  expect(() => validateRecording(new Uint8Array(MAX_AUDIO_BYTES + 1))).toThrow();
  expect(() => validateRecording(new TextEncoder().encode("RIFF0000WAVEdata"))).not.toThrow();
  expect(() =>
    validateRecording(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])),
  ).not.toThrow();
});
const none = { ffmpeg: null, whisper: null, model: null };
const model = { path: "/m/ggml-base.bin", info: describeModelFile("ggml-base.bin")! };
plainIt("tells the user exactly what to install", () => {
  expect(missingToolsReason({ ...none, model })).toContain("brew install whisper-cpp ffmpeg");
  expect(missingToolsReason({ ffmpeg: "/f", whisper: null, model })).toContain(
    "brew install whisper-cpp ffmpeg",
  );
  expect(missingToolsReason({ ffmpeg: "/f", whisper: "/w", model: null })).toContain("model");
  expect(missingToolsReason({ ffmpeg: "/f", whisper: "/w", model })).toBeNull();
});
plainIt("pins English on an English system and detects the language elsewhere", () => {
  expect(whisperLanguage(true, "de-DE")).toBe("en");
  expect(whisperLanguage(false, "en-US")).toBe("en");
  expect(whisperLanguage(false, "en")).toBe("en");
  expect(whisperLanguage(false, "es-MX")).toBe("auto");
});
plainIt("uses most cores but leaves one, up to eight", () => {
  expect([1, 2, 4, 8, 10, 16].map(whisperThreads)).toEqual([1, 1, 3, 7, 8, 8]);
});
it.effect("finds the best model across every folder it searches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "dictation-models-test-" });
    const put = (directory: string, file: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, directory), { recursive: true });
        yield* fs.writeFileString(path.join(root, directory, file), "x");
      });
    yield* put(".local/share/whisper", "ggml-base.en.bin");
    yield* put(".local/share/whisper-models", "ggml-small.bin");
    const home = process.env.HOME;
    process.env.HOME = root;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (home === undefined) delete process.env.HOME;
        else process.env.HOME = home;
      }),
    );
    expect((yield* inspectDictationTools()).model?.info.label).toBe("Whisper Small");

    yield* put("data/whisper", "ggml-large-v3-turbo-q5_0.bin");
    const found = yield* inspectDictationTools(path.join(root, "data"));
    expect(found.model?.info.label).toBe("Whisper Large v3 Turbo");
    expect(found.model?.path).toBe(path.join(root, "data/whisper/ggml-large-v3-turbo-q5_0.bin"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
