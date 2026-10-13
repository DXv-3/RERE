import { describe, expect, it, vi } from "vite-plus/test";

const { spawnedPollers } = vi.hoisted(() => ({
  spawnedPollers: [] as Array<{
    command: string;
    args: ReadonlyArray<string>;
    kill: ReturnType<typeof vi.fn>;
    emitStderr: (text: string) => void;
    emitExit: (code: number) => void;
  }>,
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: ReadonlyArray<string>) => {
    const stderrListeners: Array<(chunk: Buffer) => void> = [];
    const onceListeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      command,
      args,
      kill: vi.fn(() => true),
      emitStderr: (text: string) => {
        for (const listener of stderrListeners) listener(Buffer.from(text));
      },
      emitExit: (code: number) => {
        for (const listener of onceListeners.get("exit") ?? []) listener(code);
      },
    };
    spawnedPollers.push(record);
    const child = {
      stderr: {
        on: (_event: "data", listener: (chunk: Buffer) => void) => {
          stderrListeners.push(listener);
          return child;
        },
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        onceListeners.set(event, [...(onceListeners.get(event) ?? []), listener]);
        return child;
      },
      kill: record.kill,
    };
    return child;
  },
}));

import { startMacVoiceKeyProcess } from "./MacVoiceKeyProcess.ts";

describe("macOS voice key poller", () => {
  it("passes the key and mode, reports key events after ready, and kills on stop", async () => {
    spawnedPollers.length = 0;
    const onEvent = vi.fn();
    const onFailure = vi.fn();
    const started = startMacVoiceKeyProcess("rightOption", "hold", onEvent, onFailure);
    const poller = spawnedPollers[0]!;
    expect(poller.command).toBe("/usr/bin/osascript");
    // Right Option down, the Option flag it raises, left Option, mode, hold ticks, interval.
    expect(poller.args.slice(-8)).toEqual(["64", "524288", "32", "hold", "12", "0.025", "3", "16"]);

    // Nothing counts before the poller says it is watching, and unknown lines never do.
    poller.emitStderr("down\nready\ndo");
    const stop = await started;
    poller.emitStderr("wn\nnoise\nup\npress\ntap\ncancel\n");
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      "down",
      "up",
      "press",
      "tap",
      "cancel",
    ]);

    stop();
    expect(poller.kill).toHaveBeenCalledOnce();
    poller.emitStderr("tap\n");
    expect(onEvent).toHaveBeenCalledTimes(5);
    poller.emitExit(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("watches Fn by its own flag with no twin key", () => {
    spawnedPollers.length = 0;
    void startMacVoiceKeyProcess(
      "fn",
      "tap",
      () => undefined,
      () => undefined,
    ).catch(() => undefined);
    expect(spawnedPollers[0]!.args.slice(-8, -4)).toEqual(["8388608", "8388608", "0", "tap"]);
  });

  it("reports an unexpected exit after startup and rejects one before it", async () => {
    spawnedPollers.length = 0;
    const onFailure = vi.fn();
    const started = startMacVoiceKeyProcess("fn", "tap", () => undefined, onFailure);
    spawnedPollers[0]!.emitStderr("ready\n");
    await started;
    spawnedPollers[0]!.emitExit(1);
    expect(onFailure).toHaveBeenCalledOnce();

    const early = startMacVoiceKeyProcess(
      "fn",
      "tap",
      () => undefined,
      () => undefined,
    );
    spawnedPollers[1]!.emitExit(1);
    await expect(early).rejects.toThrow(/exited with code 1/);
  });
});
