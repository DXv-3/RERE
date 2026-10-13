import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadPath,
  readAgentView,
  readRememberedThread,
  resolveAgentTabView,
  resolveThreadTabTarget,
} from "./tabMemory";

const env = "env-1" as EnvironmentId;
const thread = (id: string, updatedAt: string, archivedAt: string | null = null) => ({
  environmentId: env,
  id,
  archivedAt,
  updatedAt,
});
const threads = [
  thread("a", "2026-01-01"),
  thread("b", "2026-02-01"),
  thread("old", "2026-03-01", "x"),
];
const owned = new Map([[env, new Set(["agent-thread"])]]);

describe("parseThreadPath", () => {
  it("reads a thread route and skips other two-part pages", () => {
    expect(parseThreadPath("/env-1/t%201")).toEqual({ environmentId: "env-1", threadId: "t 1" });
    expect(parseThreadPath("/settings/general")).toBeNull();
    expect(parseThreadPath("/draft/abc")).toBeNull();
    expect(parseThreadPath("/")).toBeNull();
    expect(parseThreadPath("/usage")).toBeNull();
  });
});

describe("resolveThreadTabTarget", () => {
  const remembered = { environmentId: env, threadId: "a" };
  it("keeps an ordinary thread that is already open", () => {
    expect(resolveThreadTabTarget({ pathname: "/env-1/b", remembered, threads, owned })).toEqual({
      kind: "stay",
    });
  });
  it("returns to the remembered thread from an agent conversation or the board", () => {
    for (const pathname of ["/env-1/agent-thread", "/"]) {
      expect(resolveThreadTabTarget({ pathname, remembered, threads, owned })).toEqual({
        kind: "thread",
        environmentId: env,
        threadId: "a",
      });
    }
  });
  it("falls back to the most recent ordinary thread when the remembered one is gone", () => {
    for (const gone of [
      { environmentId: env, threadId: "missing" },
      { environmentId: env, threadId: "old" },
      { environmentId: env, threadId: "agent-thread" },
    ]) {
      expect(
        resolveThreadTabTarget({
          pathname: "/env-1/agent-thread",
          remembered: gone,
          threads,
          owned,
        }),
      ).toEqual({ kind: "thread", environmentId: env, threadId: "b" });
    }
  });
  it("leaves a non-thread page alone when nothing is remembered, and goes home with no threads", () => {
    expect(resolveThreadTabTarget({ pathname: "/", remembered: null, threads, owned })).toEqual({
      kind: "stay",
    });
    expect(
      resolveThreadTabTarget({
        pathname: "/env-1/agent-thread",
        remembered: null,
        threads: [],
        owned,
      }),
    ).toEqual({ kind: "home" });
  });
});

describe("resolveAgentTabView", () => {
  it("restores the remembered view", () => {
    for (const remembered of ["board", "checkins", "campaigns", "schedules", "details"] as const) {
      expect(
        resolveAgentTabView({ currentIsAgentOwned: false, remembered, hasSelectedAgent: true }),
      ).toBe(remembered);
    }
    expect(
      resolveAgentTabView({
        currentIsAgentOwned: false,
        remembered: "conversation",
        hasSelectedAgent: true,
      }),
    ).toBe("conversation");
  });
  it("shows the conversation already on screen", () => {
    expect(
      resolveAgentTabView({
        currentIsAgentOwned: true,
        remembered: "board",
        hasSelectedAgent: false,
      }),
    ).toBe("conversation");
  });
  it("falls back to the board when there is no agent to show", () => {
    expect(
      resolveAgentTabView({
        currentIsAgentOwned: false,
        remembered: "conversation",
        hasSelectedAgent: false,
      }),
    ).toBe("board");
  });
});

describe("stored values", () => {
  it("rejects bad shapes", () => {
    expect(readRememberedThread({ environmentId: "e", threadId: "" })).toBeNull();
    expect(readRememberedThread("x")).toBeNull();
    expect(readRememberedThread({ environmentId: "e", threadId: "t" })).toEqual({
      environmentId: "e",
      threadId: "t",
    });
    expect(readAgentView("nope")).toBe("conversation");
    expect(readAgentView("board")).toBe("board");
    expect(readAgentView("campaigns")).toBe("campaigns");
    expect(readAgentView("schedules")).toBe("schedules");
  });
});
