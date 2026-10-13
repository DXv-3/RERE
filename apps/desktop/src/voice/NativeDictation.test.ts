import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppleAvailability,
  createNativeDictation,
  NativeDictationError,
  type HelperProcess,
  type NativeDictationEvent,
} from "./NativeDictation.ts";

function fakeHelper() {
  let stdout: (chunk: string) => void = () => undefined;
  let exit: () => void = () => undefined;
  const lines: string[] = [];
  const kill = vi.fn();
  const process: HelperProcess = {
    onStdout: (listener) => (stdout = listener),
    onExit: (listener) => (exit = listener),
    onError: () => undefined,
    writeLine: (line) => lines.push(line),
    kill,
  };
  return {
    process,
    lines,
    kill,
    say: (...events: object[]) => events.forEach((e) => stdout(`${JSON.stringify(e)}\n`)),
    raw: (chunk: string) => stdout(chunk),
    exit: () => exit(),
  };
}

function setup(path: string | null = "/helper") {
  const helpers: ReturnType<typeof fakeHelper>[] = [];
  const events: NativeDictationEvent[] = [];
  const dictation = createNativeDictation({
    spawn: () => {
      const helper = fakeHelper();
      helpers.push(helper);
      return helper.process;
    },
    helperPath: () => path ?? undefined,
    emit: (event) => events.push(event),
    startTimeoutMs: 1000,
    stopTimeoutMs: 1000,
  });
  return { dictation, helpers, events, helper: () => helpers[helpers.length - 1]! };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: NativeDictationError) => error.code,
  );

describe("NativeDictation", () => {
  it("starts when the helper is ready, streams partials, and stops with the final text", async () => {
    const { dictation, events, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "ready" });
    await started;
    helper().say({ type: "partial", text: "hello" }, { type: "silence" });
    expect(events).toEqual([{ type: "partial", text: "hello" }, { type: "silence" }]);
    const stopped = dictation.stop();
    expect(helper().lines).toEqual(["stop"]);
    helper().say({ type: "final", text: "hello world" });
    await expect(stopped).resolves.toBe("hello world");
    expect(helper().kill).toHaveBeenCalled();
    expect(dictation.isActive()).toBe(false);
  });

  it("keeps what was said before a pause when the recognizer starts its transcript over", async () => {
    const { dictation, events, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "ready" });
    await started;
    helper().say(
      { type: "partial", text: "The voice to text is not working correctly." },
      { type: "partial", text: "Any" },
      { type: "partial", text: "Anytime I pause" },
    );
    expect(events.at(-1)).toEqual({
      type: "partial",
      text: "The voice to text is not working correctly. Anytime I pause",
    });
    const stopped = dictation.stop();
    helper().say({ type: "final", text: "Anytime I pause it overrides." });
    await expect(stopped).resolves.toBe(
      "The voice to text is not working correctly. Anytime I pause it overrides.",
    );
  });

  it("allows only one session at a time", async () => {
    const { dictation, helpers, helper } = setup();
    const first = dictation.start();
    expect(await code(dictation.start())).toBe("busy");
    helper().say({ type: "ready" });
    await first;
    expect(await code(dictation.start())).toBe("busy");
    expect(helpers).toHaveLength(1);
    dictation.cancel();
    const second = dictation.start();
    helper().say({ type: "ready" });
    await second;
    expect(helpers).toHaveLength(2);
  });

  it("reports a missing helper without spawning", async () => {
    const { dictation, helpers } = setup(null);
    expect(await code(dictation.start())).toBe("helper_missing");
    expect(helpers).toHaveLength(0);
  });

  it("rejects start with the helper's error code", async () => {
    const { dictation, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "error", code: "on_device_unavailable", message: "no" });
    expect(await code(started)).toBe("on_device_unavailable");
    expect(dictation.isActive()).toBe(false);
  });

  it("rejects start when the helper exits early or never answers", async () => {
    vi.useFakeTimers();
    try {
      const early = setup();
      const a = early.dictation.start();
      early.helper().exit();
      expect(await code(a)).toBe("helper_exited");

      const slow = setup();
      const b = code(slow.dictation.start());
      await vi.advanceTimersByTimeAsync(1001);
      expect(await b).toBe("start_timeout");
      expect(slow.helper().kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates split lines, junk and unknown types", async () => {
    const { dictation, events, helper } = setup();
    const started = dictation.start();
    helper().raw('{"type":"rea');
    helper().raw('dy"}\nwarning: noise\n{"type":"mystery"}\n');
    await started;
    helper().raw('{"type":"partial","text":"a"}\n{"type":"par');
    expect(events).toEqual([{ type: "partial", text: "a" }]);
  });

  it("returns the last words when the helper exits during stop without a final", async () => {
    const { dictation, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "ready" }, { type: "partial", text: "almost" });
    await started;
    const stopped = dictation.stop();
    helper().exit();
    await expect(stopped).resolves.toBe("almost");
  });

  it("gives up waiting for a final after the stop deadline", async () => {
    vi.useFakeTimers();
    try {
      const { dictation, helper } = setup();
      const started = dictation.start();
      helper().say({ type: "ready" }, { type: "partial", text: "words" });
      await started;
      const stopped = dictation.stop();
      await vi.advanceTimersByTimeAsync(1001);
      await expect(stopped).resolves.toBe("words");
      expect(helper().kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the renderer when the helper dies mid-session and still hands over the words", async () => {
    const { dictation, events, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "ready" }, { type: "partial", text: "kept" });
    await started;
    helper().exit();
    expect(events.at(-1)).toMatchObject({ type: "error", code: "helper_exited" });
    await expect(dictation.stop()).resolves.toBe("kept");
  });

  it("cancel discards everything and kills the helper", async () => {
    const { dictation, events, helper } = setup();
    const started = dictation.start();
    helper().say({ type: "ready" }, { type: "partial", text: "gone" });
    await started;
    dictation.cancel();
    expect(helper().kill).toHaveBeenCalled();
    expect(await code(dictation.stop())).toBe("not_running");
    helper().say({ type: "partial", text: "late" });
    expect(events).toEqual([{ type: "partial", text: "gone" }]);
  });
});

describe("createAppleAvailability", () => {
  const probe = '{"supported":true,"onDevice":true,"locale":"en-US","engine":"sfspeech"}';
  it("is false off macOS or without a helper, without probing", async () => {
    const runProbe = vi.fn(async () => probe);
    expect(
      await createAppleAvailability({ platform: "linux", helperPath: () => "/h", runProbe })(),
    ).toBe(false);
    expect(
      await createAppleAvailability({
        platform: "darwin",
        helperPath: () => undefined,
        runProbe,
      })(),
    ).toBe(false);
    expect(runProbe).not.toHaveBeenCalled();
  });

  it("probes once and caches the answer", async () => {
    const runProbe = vi.fn(async () => probe);
    const available = createAppleAvailability({
      platform: "darwin",
      helperPath: () => "/h",
      runProbe,
    });
    expect(await available()).toBe(true);
    expect(await available()).toBe(true);
    expect(runProbe).toHaveBeenCalledTimes(1);
  });

  it("retries after a probe that could not run", async () => {
    const runProbe = vi
      .fn<(path: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValue(probe);
    const available = createAppleAvailability({
      platform: "darwin",
      helperPath: () => "/h",
      runProbe,
    });
    expect(await available()).toBe(false);
    expect(await available()).toBe(true);
  });
});
