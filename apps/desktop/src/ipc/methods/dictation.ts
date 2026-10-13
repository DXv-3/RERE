import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as DesktopAppIdentity from "../../app/DesktopAppIdentity.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as FileSystem from "effect/FileSystem";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { ACCURATE_MODEL } from "../../voice/dictationModels.ts";
import {
  inspectDictationTools,
  missingToolsReason,
  transcribeLocalRecording,
} from "../../voice/localDictation.ts";
import { makeModelDownloader } from "../../voice/modelDownload.ts";
import { resolveDictationEngine } from "../../voice/dictationEngine.ts";
import {
  createAppleAvailability,
  createNativeDictation,
  NativeDictationError,
  runHelperProbe,
  spawnHelperProcess,
  type NativeDictation,
} from "../../voice/NativeDictation.ts";
import * as Channels from "../channels.ts";
class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  message: Schema.String,
}) {}
export const trusted = Effect.fn(function* (event?: DesktopIpc.DesktopIpcInvokeEvent) {
  const windows = yield* ElectronWindow.ElectronWindow;
  const window = yield* windows.currentMainOrFirst;
  if (!event || Option.isNone(window) || window.value.webContents.id !== event.sender.id)
    return yield* new DictationError({
      message: "Dictation is available only in the main CodeWrench window.",
    });
});
/** Where the app keeps models it downloads, and the first place it looks for any. */
const userDataDirectory = Effect.gen(function* () {
  const identity = yield* DesktopAppIdentity.DesktopAppIdentity;
  return Option.getOrUndefined(yield* identity.resolveUserDataPath.pipe(Effect.option));
});
const downloader = makeModelDownloader();
const optionalDirectory = (directory: string | undefined) =>
  directory === undefined ? {} : { userDataDirectory: directory };
const NATIVE_HELPER_NAME = "codewrench-speech";

/** Packaged: next to the other bundled helpers in Resources. Dev: where `native/mac-speech/build.sh` writes it. */
const findNativeHelper = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  if (environment.platform !== "darwin") return undefined;
  const candidate = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "mac-speech", NATIVE_HELPER_NAME)
    : environment.path.join(environment.rootDir, "native/mac-speech/build", NATIVE_HELPER_NAME);
  return (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
    ? candidate
    : undefined;
});

interface NativeSpeech {
  readonly session: NativeDictation;
  readonly appleAvailable: () => Promise<boolean>;
}
let nativeSpeech: NativeSpeech | undefined;

/** One helper session for the whole app, so two windows can never both listen. */
const getNativeSpeech = Effect.gen(function* () {
  if (nativeSpeech) return nativeSpeech;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const windows = yield* ElectronWindow.ElectronWindow;
  const helper = yield* findNativeHelper;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const helperPath = () => helper;
  nativeSpeech = {
    session: createNativeDictation({
      spawn: spawnHelperProcess,
      helperPath,
      // Words go to the main window only, never to preview or helper windows.
      emit: (event) =>
        void runFork(
          windows.currentMainOrFirst.pipe(
            Effect.flatMap((window) =>
              Option.isSome(window)
                ? Effect.sync(() =>
                    window.value.webContents.send(Channels.NATIVE_DICTATION_EVENT_CHANNEL, event),
                  )
                : Effect.void,
            ),
          ),
        ),
    }),
    appleAvailable: createAppleAvailability({
      platform: environment.platform,
      helperPath,
      runProbe: runHelperProbe,
    }),
  };
  return nativeSpeech;
});

/** The renderer reads the helper's error code from the front of the message. */
const nativeError = (error: unknown) =>
  new DictationError({
    message:
      error instanceof NativeDictationError
        ? `[${error.code}] ${error.message}`
        : "[recognition_failed] Apple speech failed.",
  });

const ModelProgress = Schema.Struct({ bytesDone: Schema.Number, bytesTotal: Schema.Number });
export const getDictationStatus = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_STATUS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({
    available: Schema.Boolean,
    model: Schema.String,
    reason: Schema.NullOr(Schema.String),
    betterModelAvailable: Schema.Boolean,
    modelDownloadBytes: Schema.Number,
    modelDownload: Schema.NullOr(ModelProgress),
    engine: Schema.Literals(["apple", "whisper"]),
    appleAvailable: Schema.Boolean,
    // What Whisper alone would say, for when Apple's engine fails to start and Whisper takes over.
    whisperReason: Schema.NullOr(Schema.String),
    whisperModel: Schema.String,
  }),
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    const found = yield* inspectDictationTools(yield* userDataDirectory).pipe(
      Effect.mapError(
        () => new DictationError({ message: "Could not check local dictation tools." }),
      ),
    );
    const speech = yield* getNativeSpeech;
    const appleAvailable = yield* Effect.promise(() => speech.appleAvailable());
    const settings = yield* (yield* DesktopClientSettings.DesktopClientSettings).get;
    const engine = resolveDictationEngine(
      Option.match(settings, {
        onNone: () => "auto" as const,
        onSome: (value) => value.dictationEngine,
      }),
      appleAvailable,
    );
    const reason = missingToolsReason(found);
    return {
      engine,
      appleAvailable,
      whisperReason: reason,
      whisperModel: found.model?.info.label ?? "",
      // Apple's engine needs none of the whisper tools.
      available: engine === "apple" || reason === null,
      model: engine === "apple" ? "Apple on-device speech" : (found.model?.info.label ?? ""),
      reason: engine === "apple" ? null : reason,
      // Offered once the programs are installed, since a model is no use before them.
      betterModelAvailable:
        found.ffmpeg !== null &&
        found.whisper !== null &&
        (found.model === null || found.model.info.worthUpgrading),
      modelDownloadBytes: ACCURATE_MODEL.bytes,
      modelDownload: downloader.progress(),
    };
  }),
});
const transcribe = (kind: "preview" | "final") =>
  Effect.fn(function* (bytes: Uint8Array, event?: DesktopIpc.DesktopIpcInvokeEvent) {
    yield* trusted(event);
    return yield* transcribeLocalRecording(bytes, {
      kind,
      ...optionalDirectory(yield* userDataDirectory),
    }).pipe(Effect.mapError((error) => new DictationError({ message: error.message })));
  });
export const transcribeDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_TRANSCRIBE_CHANNEL,
  payload: Schema.Uint8Array,
  result: Schema.String,
  handler: transcribe("final"),
});
export const previewDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_PREVIEW_CHANNEL,
  payload: Schema.Uint8Array,
  result: Schema.String,
  handler: transcribe("preview"),
});
export const downloadDictationModel = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_MODEL_DOWNLOAD_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    const windows = yield* ElectronWindow.ElectronWindow;
    const path = yield* Path.Path;
    const base = yield* userDataDirectory;
    const directory = path.join(
      base ?? path.join(NodeOS.homedir(), "Library/Application Support/CodeWrench"),
      "whisper",
    );
    yield* downloader
      .download({
        url: ACCURATE_MODEL.url,
        directory,
        file: ACCURATE_MODEL.file,
        expectedBytes: ACCURATE_MODEL.bytes,
        sha256: ACCURATE_MODEL.sha256,
        onProgress: (progress) =>
          windows.sendAll(Channels.DICTATION_MODEL_PROGRESS_CHANNEL, progress),
      })
      .pipe(Effect.mapError((error) => new DictationError({ message: error.message })));
  }),
});
export const cancelDictationModelDownload = DesktopIpc.makeIpcMethod({
  channel: Channels.DICTATION_MODEL_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    return yield* downloader.cancel;
  }),
});

export const startNativeDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.NATIVE_DICTATION_START_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    const speech = yield* getNativeSpeech;
    yield* Effect.tryPromise({ try: () => speech.session.start(), catch: nativeError });
  }),
});

export const stopNativeDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.NATIVE_DICTATION_STOP_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    const speech = yield* getNativeSpeech;
    return yield* Effect.tryPromise({ try: () => speech.session.stop(), catch: nativeError });
  }),
});

export const cancelNativeDictation = DesktopIpc.makeIpcMethod({
  channel: Channels.NATIVE_DICTATION_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn(function* (_, event) {
    yield* trusted(event);
    const speech = yield* getNativeSpeech;
    speech.session.cancel();
  }),
});
