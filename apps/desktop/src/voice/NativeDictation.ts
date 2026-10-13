// @effect-diagnostics globalTimers:off -- The helper's start and stop deadlines are plain timers on a child process.
// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native speech helper with Node.
import * as NodeChildProcess from "node:child_process";
import {
  createNativeSpeechLineParser,
  parseNativeSpeechProbe,
  probeAllowsApple,
  type NativeSpeechEvent,
} from "./nativeSpeechProtocol.ts";
import { createTranscriptAccumulator } from "./transcriptAccumulator.ts";

/** A failure with a stable code the renderer can act on (see `classifyNativeSpeechError`). */
export class NativeDictationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeDictationError";
    this.code = code;
  }
}

/** The part of a child process the session needs, so tests can stand in for the real helper. */
export interface HelperProcess {
  readonly onStdout: (listener: (chunk: string) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly onError: (listener: (error: Error) => void) => void;
  readonly writeLine: (line: string) => void;
  readonly kill: () => void;
}
export type SpawnHelper = (path: string, args: readonly string[]) => HelperProcess;

export type NativeDictationEvent =
  | { readonly type: "partial"; readonly text: string }
  | { readonly type: "silence" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface NativeDictationOptions {
  readonly spawn: SpawnHelper;
  /** Where the helper binary is, or undefined when this build has none. */
  readonly helperPath: () => string | undefined;
  readonly emit: (event: NativeDictationEvent) => void;
  /** Long enough for the user to answer the system's permission prompt. */
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

type Phase = "idle" | "starting" | "listening" | "stopping";

/**
 * Owns the speech helper process: at most one session at a time. `start` resolves once the helper
 * reports it is listening, `stop` resolves with the final text, `cancel` throws the session away.
 */
export function createNativeDictation(options: NativeDictationOptions) {
  const startTimeoutMs = options.startTimeoutMs ?? 60_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  let phase: Phase = "idle";
  let helper: HelperProcess | null = null;
  // The helper's transcript starts over after a pause; this keeps the earlier utterances.
  const transcript = createTranscriptAccumulator();
  let text = "";
  let finished: string | null = null;
  let failure: NativeDictationError | null = null;
  let settleStart: ((error?: NativeDictationError) => void) | null = null;
  let settleStop: ((result: string) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  // Ends the session whatever state it is in. Late output from the old process is ignored.
  const finish = () => {
    clearTimer();
    const old = helper;
    helper = null;
    phase = "idle";
    old?.kill();
  };

  const handle = (event: NativeSpeechEvent) => {
    switch (event.type) {
      case "ready":
        if (phase === "starting") {
          phase = "listening";
          clearTimer();
          settleStart?.();
          settleStart = null;
        }
        return;
      case "partial":
        text = transcript.update(event.text);
        if (phase === "listening") options.emit({ type: "partial", text });
        return;
      case "final":
        text = transcript.update(event.text);
        finished = text;
        if (phase === "stopping") {
          settleStop?.(text);
          settleStop = null;
          finish();
        }
        return;
      case "silence":
        if (phase === "listening") options.emit({ type: "silence" });
        return;
      case "error": {
        const error = new NativeDictationError(event.code, event.message);
        if (phase === "starting") {
          settleStart?.(error);
          settleStart = null;
        } else if (phase === "stopping") {
          // Whatever was heard is still better than nothing.
          settleStop?.(finished ?? text);
          settleStop = null;
        } else if (phase === "listening") {
          failure = error;
          options.emit({ type: "error", code: error.code, message: error.message });
        }
        finish();
        return;
      }
    }
  };

  // The helper went away by itself.
  const exited = () => {
    if (phase === "idle") return;
    if (phase === "starting") {
      settleStart?.(
        new NativeDictationError("helper_exited", "The speech helper stopped before it was ready."),
      );
      settleStart = null;
    } else if (phase === "stopping") {
      settleStop?.(finished ?? text);
      settleStop = null;
    } else {
      failure = new NativeDictationError(
        "helper_exited",
        "The speech helper stopped unexpectedly.",
      );
      options.emit({ type: "error", code: failure.code, message: failure.message });
    }
    finish();
  };

  const start = (): Promise<void> => {
    if (phase !== "idle") {
      return Promise.reject(new NativeDictationError("busy", "Dictation is already listening."));
    }
    const path = options.helperPath();
    if (!path) {
      return Promise.reject(
        new NativeDictationError("helper_missing", "This build has no Apple speech helper."),
      );
    }
    phase = "starting";
    transcript.reset();
    text = "";
    finished = null;
    failure = null;
    return new Promise<void>((resolve, reject) => {
      let process: HelperProcess;
      try {
        process = options.spawn(path, []);
      } catch (cause) {
        phase = "idle";
        reject(
          new NativeDictationError(
            "helper_missing",
            cause instanceof Error ? cause.message : "The speech helper could not be started.",
          ),
        );
        return;
      }
      helper = process;
      settleStart = (error) => (error ? reject(error) : resolve());
      timer = setTimeout(() => {
        settleStart?.(
          new NativeDictationError("start_timeout", "The speech helper did not start in time."),
        );
        settleStart = null;
        finish();
      }, startTimeoutMs);
      const parser = createNativeSpeechLineParser();
      // Output of a replaced or ended session must not touch the new one.
      const current = () => helper === process;
      process.onStdout((chunk) => {
        if (current()) parser.push(chunk).forEach(handle);
      });
      process.onError((error) => {
        if (!current()) return;
        settleStart?.(new NativeDictationError("helper_missing", error.message));
        settleStart = null;
        finish();
      });
      process.onExit(() => {
        if (!current()) return;
        parser.flush().forEach(handle);
        if (current()) exited();
      });
    });
  };

  const stop = (): Promise<string> => {
    if (phase === "idle") {
      // A helper that died mid-recording still hands over what it heard.
      if (failure) {
        const heard = finished ?? text;
        const error = failure;
        failure = null;
        return heard ? Promise.resolve(heard) : Promise.reject(error);
      }
      return Promise.reject(new NativeDictationError("not_running", "Dictation is not running."));
    }
    if (phase !== "listening") {
      return Promise.reject(new NativeDictationError("busy", "Dictation is still starting."));
    }
    phase = "stopping";
    return new Promise<string>((resolve) => {
      settleStop = resolve;
      timer = setTimeout(() => {
        settleStop?.(finished ?? text);
        settleStop = null;
        finish();
      }, stopTimeoutMs);
      helper?.writeLine("stop");
    });
  };

  const cancel = () => {
    settleStart?.(new NativeDictationError("cancelled", "Dictation was cancelled."));
    settleStart = null;
    settleStop?.("");
    settleStop = null;
    failure = null;
    transcript.reset();
    text = "";
    finished = null;
    finish();
  };

  return { start, stop, cancel, isActive: () => phase !== "idle" };
}
export type NativeDictation = ReturnType<typeof createNativeDictation>;

/** Spawns the helper with Node. stdin carries `stop`; stdout carries the JSON lines. */
export const spawnHelperProcess: SpawnHelper = (path, args) => {
  const child = NodeChildProcess.spawn(path, [...args], { stdio: ["pipe", "pipe", "ignore"] });
  // A closed pipe after the helper exits is not worth crashing the app for.
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  return {
    onStdout: (listener) => child.stdout.on("data", listener),
    onExit: (listener) => child.on("close", listener),
    onError: (listener) => child.on("error", listener),
    writeLine: (line) => {
      child.stdin.write(`${line}\n`);
    },
    kill: () => {
      child.kill("SIGTERM");
    },
  };
};

/** Runs `helper --probe` once and says whether on-device Apple speech works here. */
export function createAppleAvailability(options: {
  readonly platform: string;
  readonly helperPath: () => string | undefined;
  readonly runProbe: (path: string) => Promise<string>;
}): () => Promise<boolean> {
  let cached: Promise<boolean> | null = null;
  return () => {
    if (options.platform !== "darwin") return Promise.resolve(false);
    const path = options.helperPath();
    if (!path) return Promise.resolve(false);
    // A probe that could not run is retried next time; a real answer is kept for the session.
    cached ??= options.runProbe(path).then(
      (output) => probeAllowsApple(parseNativeSpeechProbe(output)),
      () => {
        cached = null;
        return false;
      },
    );
    return cached;
  };
}

export const runHelperProbe = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(path, ["--probe"], { timeout: 5000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
