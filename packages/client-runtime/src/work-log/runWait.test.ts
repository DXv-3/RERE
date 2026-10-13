import { describe, expect, it } from "vite-plus/test";

import { describeRunWait, formatQuietLabel, resolveQuietMinutes } from "./runWait.ts";

const START = "2026-10-06T10:00:00.000Z";
const startMs = Date.parse(START);
const at = (minutes: number, seconds = 0) => startMs + minutes * 60_000 + seconds * 1_000;

describe("describeRunWait", () => {
  it("reads plain sleeps with units", () => {
    expect(describeRunWait({ command: "sleep 300" }, at(0))).toMatchObject({
      kind: "sleep",
      totalMs: 300_000,
      remainingMs: null,
      label: "Sleeping 5 min",
    });
    expect(describeRunWait({ command: "sleep 5m" }, at(0))?.totalMs).toBe(300_000);
    expect(describeRunWait({ command: "sleep 2h" }, at(0))?.label).toBe("Sleeping 2 h");
    expect(describeRunWait({ command: "sleep 90s" }, at(0))?.label).toBe("Sleeping 2 min");
    expect(describeRunWait({ command: "sleep 30" }, at(0))?.label).toBe("Sleeping 30 sec");
  });

  it("shows time left when the start is known and drops it once elapsed", () => {
    const input = { command: "sleep 5m", startedAt: START };
    expect(describeRunWait(input, at(1, 48))?.label).toBe("Sleeping 5 min (4 min left)");
    expect(describeRunWait(input, at(4, 30))?.label).toBe("Sleeping 5 min (1 min left)");
    expect(describeRunWait(input, at(6))).toMatchObject({
      remainingMs: 0,
      label: "Sleeping 5 min",
    });
  });

  it("accepts a sleep as the final command of a chain or inside a shell wrapper", () => {
    expect(describeRunWait({ command: "cd app && sleep 60" }, at(0))?.totalMs).toBe(60_000);
    expect(describeRunWait({ command: "echo hi; sleep 2m" }, at(0))?.totalMs).toBe(120_000);
    expect(describeRunWait({ command: `/bin/bash -lc "sleep 120"` }, at(0))?.totalMs).toBe(120_000);
    expect(describeRunWait({ command: "timeout 45" }, at(0))?.totalMs).toBe(45_000);
    expect(describeRunWait({ command: "timeout /t 45" }, at(0))?.totalMs).toBe(45_000);
  });

  it("never guesses", () => {
    for (const command of [
      "sleep 5 && npm test",
      "sleep $DELAY",
      "sleep 1m 30s",
      "sleep infinity",
      "sleep 0",
      "timeout 30 npm test",
      "sleep 5 | cat",
      "if x; then sleep 5; fi",
      "npm run sleep",
      "",
    ]) {
      expect(describeRunWait({ command }, at(0)), command).toBeNull();
    }
  });

  it("names browser waits and ignores other tools", () => {
    expect(describeRunWait({ toolName: "mcp__t3-code__preview_wait_for" }, at(0))?.label).toBe(
      "Waiting on a page",
    );
    expect(describeRunWait({ toolName: "preview_wait_for" }, at(0))?.kind).toBe("page");
    expect(describeRunWait({ toolName: "preview_click" }, at(0))).toBeNull();
    expect(describeRunWait({}, at(0))).toBeNull();
  });
});

describe("resolveQuietMinutes", () => {
  it("is null before the threshold and counts minutes after it", () => {
    const base = { runStartedAt: START, lastActivityAt: START };
    expect(resolveQuietMinutes({ ...base, nowMs: at(9, 59) })).toBeNull();
    expect(resolveQuietMinutes({ ...base, nowMs: at(10) })).toBe(10);
    expect(resolveQuietMinutes({ ...base, nowMs: at(12, 30) })).toBe(12);
  });

  it("counts from the later of run start and last output, and tolerates bad timestamps", () => {
    expect(
      resolveQuietMinutes({
        runStartedAt: START,
        lastActivityAt: "2026-10-06T10:20:00.000Z",
        nowMs: at(25),
      }),
    ).toBeNull();
    expect(
      resolveQuietMinutes({ runStartedAt: START, lastActivityAt: "nope", nowMs: at(15) }),
    ).toBe(15);
    expect(
      resolveQuietMinutes({ runStartedAt: null, lastActivityAt: null, nowMs: at(15) }),
    ).toBeNull();
  });

  it("does not call a sleep that has not elapsed quiet, then counts from its end", () => {
    const quietAt = (minutes: number) =>
      resolveQuietMinutes({
        runStartedAt: START,
        lastActivityAt: START,
        nowMs: at(minutes),
        wait: describeRunWait({ command: "sleep 30m", startedAt: START }, at(minutes)),
      });
    expect(quietAt(20)).toBeNull();
    expect(quietAt(29)).toBeNull();
    expect(quietAt(35)).toBeNull();
    expect(quietAt(41)).toBe(11);
  });

  it("still flags a sleep with unknown start by plain silence", () => {
    const wait = describeRunWait({ command: "sleep 30m" }, at(0));
    expect(
      resolveQuietMinutes({ runStartedAt: START, lastActivityAt: START, nowMs: at(12), wait }),
    ).toBe(12);
  });
});

describe("formatQuietLabel", () => {
  it("reads minutes then hours", () => {
    expect(formatQuietLabel(12)).toBe("Quiet for 12m");
    expect(formatQuietLabel(125)).toBe("Quiet for 2h 5m");
  });
});
