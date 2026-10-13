import type { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createReplySuggestionMemory,
  isRecentTurn,
  isReplySuggestionCurrent,
  readReplySuggestion,
  shouldRequestReplySuggestion,
} from "./replySuggestion.logic";

const id = (value: string) => value as MessageId;
const finishedTurn = {
  enabled: true,
  isServerThread: true,
  phase: "ready" as const,
  turnFinished: true,
  openedOnRecentTurn: false,
  draftEmpty: true,
  lastMessage: { id: id("a1"), role: "assistant" as const, streaming: false },
  requestedFor: null,
};

describe("shouldRequestReplySuggestion", () => {
  it("asks once a turn has finished on an empty draft", () => {
    expect(shouldRequestReplySuggestion(finishedTurn)).toBe(true);
  });

  it("does not ask twice for the same assistant message", () => {
    expect(shouldRequestReplySuggestion({ ...finishedTurn, requestedFor: id("a1") })).toBe(false);
    expect(shouldRequestReplySuggestion({ ...finishedTurn, requestedFor: id("a0") })).toBe(true);
  });

  it.each([
    ["the setting is off", { enabled: false }],
    ["the thread is a local draft", { isServerThread: false }],
    ["a run is going", { phase: "running" as const }],
    ["no turn finished while watching and the thread's last turn is old", { turnFinished: false }],
    ["the user already started typing", { draftEmpty: false }],
    ["nothing has been said", { lastMessage: undefined }],
    [
      "the user spoke last",
      { lastMessage: { id: id("u1"), role: "user" as const, streaming: false } },
    ],
    [
      "the reply is still streaming",
      { lastMessage: { id: id("a1"), role: "assistant" as const, streaming: true } },
    ],
  ])("does not ask when %s", (_label, override) => {
    expect(shouldRequestReplySuggestion({ ...finishedTurn, ...override })).toBe(false);
  });
});

describe("opening a thread whose turn already finished", () => {
  it("asks when the last turn is recent, even though no run was watched", () => {
    expect(
      shouldRequestReplySuggestion({
        ...finishedTurn,
        turnFinished: false,
        openedOnRecentTurn: true,
      }),
    ).toBe(true);
  });

  it("counts a turn as recent for three days", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    expect(isRecentTurn("2026-10-06T11:00:00.000Z", now)).toBe(true);
    expect(isRecentTurn("2026-10-03T12:00:00.000Z", now)).toBe(true);
    expect(isRecentTurn("2026-10-03T11:59:59.000Z", now)).toBe(false);
    expect(isRecentTurn(undefined, now)).toBe(false);
    expect(isRecentTurn("not a date", now)).toBe(false);
  });
});

describe("readReplySuggestion", () => {
  it("keeps a clean one-line reply", () => {
    expect(readReplySuggestion("  Yes, add the tests.  ")).toBe("Yes, add the tests.");
    expect(readReplySuggestion("First line\nsecond line")).toBe("First line");
  });

  it("rejects empty, missing, and over-long replies", () => {
    expect(readReplySuggestion(null)).toBeNull();
    expect(readReplySuggestion(undefined)).toBeNull();
    expect(readReplySuggestion("   \n ")).toBeNull();
    expect(readReplySuggestion("x".repeat(121))).toBeNull();
    expect(readReplySuggestion("x".repeat(120))).toBe("x".repeat(120));
  });
});

describe("isReplySuggestionCurrent", () => {
  const base = {
    suggestion: { messageId: id("a1") },
    draftEmpty: true,
    lastMessageId: id("a1"),
    phase: "ready" as const,
  };

  it("holds while the thread and draft are as they were", () => {
    expect(isReplySuggestionCurrent(base)).toBe(true);
  });

  it.each([
    ["there is none", { suggestion: null }],
    ["the user typed", { draftEmpty: false }],
    ["a newer message arrived", { lastMessageId: id("u2") }],
    ["a new turn is running", { phase: "running" as const }],
  ])("is retired when %s", (_label, override) => {
    expect(isReplySuggestionCurrent({ ...base, ...override })).toBe(false);
  });
});

describe("createReplySuggestionMemory", () => {
  it("keeps a dismissed suggestion dismissed", () => {
    const memory = createReplySuggestionMemory(10);
    memory.set("thread:a1", "Run the tests");
    expect(memory.get("thread:a1")).toBe("Run the tests");
    memory.set("thread:a1", null);
    expect(memory.has("thread:a1")).toBe(true);
    expect(memory.get("thread:a1")).toBeNull();
  });

  it("forgets the oldest answer at the limit, but not when updating a known one", () => {
    const memory = createReplySuggestionMemory(2);
    memory.set("a", "one");
    memory.set("b", "two");
    memory.set("a", null);
    expect(memory.has("b")).toBe(true);
    memory.set("c", "three");
    expect(memory.has("a")).toBe(false);
    expect(memory.has("b")).toBe(true);
    expect(memory.has("c")).toBe(true);
  });
});
