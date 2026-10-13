import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { transcribeLocalRecording } from "./localDictation.ts";
// Explicit opt-in: exercises installed local binaries, not a mocked transcription result.
it.effect.skipIf(process.env.WORKBENCH_VOICE_LIVE !== "1")(
  "transcribes the local public-domain speech fixture",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* fs.readFile("/opt/homebrew/share/whisper-cpp/jfk.wav");
      const text = yield* transcribeLocalRecording(bytes);
      expect(text.toLowerCase()).toContain("ask not what your country can do for you");
    }).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 150000 },
);
