import * as NodeOS from "node:os";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { modelDirectories, pickBestModel, type WhisperModel } from "./dictationModels.ts";
import { DictationSupersededError, makeTranscriptionQueue } from "./transcriptionQueue.ts";
import { cleanTranscript, DICTATION_PROMPT } from "./transcriptCleanup.ts";

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export class LocalDictationError extends Schema.TaggedError<LocalDictationError>()(
  "LocalDictationError",
  { message: Schema.String },
) {}
const isLocalDictationError = Schema.is(LocalDictationError);
const isSuperseded = Schema.is(DictationSupersededError);
const DICTATION_INSTALL_COMMAND = "brew install whisper-cpp ffmpeg";

export interface DictationInspection {
  readonly ffmpeg: string | null;
  readonly whisper: string | null;
  readonly model: { readonly path: string; readonly info: WhisperModel } | null;
}

/** Finds the tools dictation needs and the best Whisper model among the installed ones. */
export const inspectDictationTools = Effect.fn(function* (userDataDirectory?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const first = Effect.fn(function* (candidates: string[]) {
    for (const candidate of candidates) if (yield* fs.exists(candidate)) return candidate;
    return null;
  });
  const ffmpeg = yield* first([
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]);
  const whisper = yield* first([
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    "/usr/bin/whisper-cli",
  ]);
  const candidates: { path: string; file: string }[] = [];
  for (const directory of modelDirectories({
    home: NodeOS.homedir(),
    userDataDirectory,
    join: path.join,
  })) {
    const files = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const file of files) candidates.push({ path: path.join(directory, file), file });
  }
  const best = pickBestModel(candidates);
  return {
    ffmpeg,
    whisper,
    model: best ? { path: best.path, info: best.model } : null,
  } satisfies DictationInspection;
});
const findDictationTools = Effect.fn(function* (userDataDirectory?: string) {
  const { ffmpeg, whisper, model } = yield* inspectDictationTools(userDataDirectory);
  return ffmpeg && whisper && model
    ? { ffmpeg, whisper, model: model.path, info: model.info }
    : null;
});
/** What to tell the user when dictation cannot run, naming the exact fix. */
export function missingToolsReason(found: DictationInspection): string | null {
  if (!found.ffmpeg || !found.whisper) {
    return `Voice dictation needs whisper-cpp and ffmpeg. In Terminal, run: ${DICTATION_INSTALL_COMMAND}`;
  }
  return found.model
    ? null
    : "Voice dictation needs a Whisper model. Download the voice model to start.";
}
/** Threads for whisper: all but one core, so the app stays responsive, up to eight. */
export const whisperThreads = (cpuCount: number) => Math.max(1, Math.min(8, cpuCount - 1));
/**
 * A multilingual model guessing the language of a few English words often guesses
 * wrong, so an English system pins it. Other systems keep detection.
 */
export const whisperLanguage = (englishOnlyModel: boolean, systemLocale: string) =>
  englishOnlyModel || /^en(-|_|$)/i.test(systemLocale) ? "en" : "auto";
export function validateRecording(bytes: Uint8Array): void {
  if (bytes.length < 12 || bytes.length > MAX_AUDIO_BYTES)
    throw new Error("Record between a moment and three minutes of audio.");
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  const wav = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (!webm && !wav)
    throw new Error("The recording format is unsupported. Use a WebM or WAV recording.");
}
const run = Effect.fn(function* (file: string, args: string[], timeout: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(file, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        shell: false,
        forceKillAfter: "2 seconds",
      }),
    )
    .pipe(Effect.timeout(`${timeout} millis`));
  if (code !== 0)
    return yield* new LocalDictationError({
      message: "Local transcription could not finish. Try a shorter recording.",
    });
});
const queue = makeTranscriptionQueue();
const transcribeNow = Effect.fn(function* (bytes: Uint8Array, userDataDirectory?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* inspectDictationTools(userDataDirectory);
  const reason = missingToolsReason(found);
  if (reason || !found.ffmpeg || !found.whisper || !found.model)
    return yield* new LocalDictationError({
      message: reason ?? "Local dictation tools are missing.",
    });
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-dictation-" });
  const input = path.join(directory, "recording.webm");
  const wav = path.join(directory, "recording.wav");
  const output = path.join(directory, "transcript");
  yield* fs.writeFile(input, bytes, { mode: 0o600 });
  yield* run(
    found.ffmpeg,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      input,
      "-t",
      "180",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      wav,
    ],
    30000,
  );
  yield* run(
    found.whisper,
    [
      "-m",
      found.model.path,
      "-f",
      wav,
      "-l",
      whisperLanguage(found.model.info.english, Intl.DateTimeFormat().resolvedOptions().locale),
      "-t",
      String(whisperThreads(NodeOS.availableParallelism())),
      "--prompt",
      DICTATION_PROMPT,
      "-otxt",
      "-of",
      output,
      "-np",
      "-nt",
    ],
    120000,
  );
  const transcript = cleanTranscript(yield* fs.readFileString(`${output}.txt`));
  if (!transcript)
    return yield* new LocalDictationError({
      message: "No speech was detected. Try speaking closer to the microphone.",
    });
  return transcript.slice(0, 100000);
});
/**
 * `final` is the recording the user stopped: it is never refused, and it interrupts a
 * running `preview` pass. A `preview` is the live partial text and may be dropped.
 */
export const transcribeLocalRecording = Effect.fn(function* (
  bytes: Uint8Array,
  options?: { readonly kind?: "preview" | "final"; readonly userDataDirectory?: string },
) {
  yield* Effect.try({
    try: () => validateRecording(bytes),
    catch: (e) =>
      new LocalDictationError({ message: e instanceof Error ? e.message : "Invalid recording." }),
  });
  return yield* queue
    .run(
      options?.kind ?? "final",
      transcribeNow(bytes, options?.userDataDirectory).pipe(Effect.scoped),
    )
    .pipe(
      Effect.mapError((e) =>
        isLocalDictationError(e) || isSuperseded(e)
          ? e
          : new LocalDictationError({
              message:
                "Local transcription could not finish. Check the local tools and try a shorter recording.",
            }),
      ),
    );
});
