import { describe, expect, it } from "vite-plus/test";

import { countThreadsNeedingYou, threadNeedsYou, type ThreadBadgeInput } from "./threadBadge.ts";

const thread = (overrides: Partial<ThreadBadgeInput> = {}): ThreadBadgeInput => ({
  archived: false,
  subagent: false,
  putAway: false,
  waitingOnYou: false,
  failed: false,
  completedAtMs: null,
  lastVisitedAtMs: null,
  ...overrides,
});

describe("threadNeedsYou", () => {
  it("counts a finished run until the thread is opened after it", () => {
    expect(threadNeedsYou(thread({ completedAtMs: 200, lastVisitedAtMs: 100 }))).toBe(true);
    expect(threadNeedsYou(thread({ completedAtMs: 200, lastVisitedAtMs: 300 }))).toBe(false);
  });

  it("does not count a thread that was never opened, matching the Done label", () => {
    expect(threadNeedsYou(thread({ completedAtMs: 200 }))).toBe(false);
  });

  it("counts approvals, questions and failures", () => {
    expect(threadNeedsYou(thread({ waitingOnYou: true }))).toBe(true);
    expect(threadNeedsYou(thread({ failed: true }))).toBe(true);
  });

  it("leaves out archived threads and subagents, and put-away threads unless they ask something", () => {
    expect(threadNeedsYou(thread({ archived: true, waitingOnYou: true }))).toBe(false);
    expect(threadNeedsYou(thread({ subagent: true, waitingOnYou: true }))).toBe(false);
    expect(
      threadNeedsYou(thread({ putAway: true, completedAtMs: 200, lastVisitedAtMs: 100 })),
    ).toBe(false);
    expect(threadNeedsYou(thread({ putAway: true, waitingOnYou: true }))).toBe(true);
  });
});

describe("countThreadsNeedingYou", () => {
  it("adds them up", () => {
    expect(
      countThreadsNeedingYou([
        thread({ waitingOnYou: true }),
        thread({ completedAtMs: 2, lastVisitedAtMs: 1 }),
        thread(),
      ]),
    ).toBe(2);
  });
});
