import type { AgentCheckIn, WorkspaceAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyReviewed,
  arrangeCheckIns,
  checkInsWaitingLabel,
  checkRedirectNote,
  countPendingByAgent,
  goalTitleFor,
} from "./agentCheckIns.ts";

function checkIn(id: string, overrides: Partial<AgentCheckIn> = {}): AgentCheckIn {
  return {
    id,
    agentId: "agent-1",
    goalId: "goal-1",
    threadId: "thread-1",
    runId: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    summary: "Checked the queue.",
    needsFromOwner: null,
    source: "agent",
    status: "pending",
    ownerNote: null,
    reviewedAt: null,
    ...overrides,
  } as AgentCheckIn;
}

const ids = (checkIns: ReadonlyArray<AgentCheckIn>) => checkIns.map((c) => c.id);

describe("arrangeCheckIns", () => {
  const pending = [
    checkIn("old", { createdAt: "2026-10-01T08:00:00.000Z" }),
    checkIn("new", { createdAt: "2026-10-02T08:00:00.000Z" }),
  ];
  const all = [
    checkIn("done-new", { status: "approved", createdAt: "2026-10-04T08:00:00.000Z" }),
    pending[1]!,
    checkIn("done-old", { status: "dismissed", createdAt: "2026-10-01T09:00:00.000Z" }),
    pending[0]!,
  ];

  it("lists only what is waiting, newest first, for the Waiting filter", () => {
    expect(ids(arrangeCheckIns({ filter: "waiting", pending, all }))).toEqual(["new", "old"]);
  });

  it("puts everything waiting before reviewed history, each newest first, for All", () => {
    expect(ids(arrangeCheckIns({ filter: "all", pending, all }))).toEqual([
      "new",
      "old",
      "done-new",
      "done-old",
    ]);
  });

  it("does not list a check-in twice when the streams overlap", () => {
    const arranged = arrangeCheckIns({ filter: "all", pending, all });
    expect(new Set(ids(arranged)).size).toBe(arranged.length);
  });

  it("lets the waiting stream win when the all stream has not caught up", () => {
    // The all stream still shows the check-in as pending; the pending stream already dropped it.
    const stale = [checkIn("gone")];
    expect(ids(arrangeCheckIns({ filter: "all", pending: [], all: stale }))).toEqual([]);
  });

  it("breaks a tie on time by id so the order is stable", () => {
    const same = [checkIn("a"), checkIn("b")];
    expect(ids(arrangeCheckIns({ filter: "waiting", pending: same, all: same }))).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("applyReviewed", () => {
  it("swaps in the reviewed copy and leaves the rest alone", () => {
    const reviewed = checkIn("a", { status: "approved" });
    const result = applyReviewed([checkIn("a"), checkIn("b")], { a: reviewed });
    expect(result.map((c) => [c.id, c.status])).toEqual([
      ["a", "approved"],
      ["b", "pending"],
    ]);
  });

  it("moves a just-reviewed check-in out of the Waiting list", () => {
    const pending = applyReviewed([checkIn("a"), checkIn("b")], {
      a: checkIn("a", { status: "dismissed" }),
    });
    expect(ids(arrangeCheckIns({ filter: "waiting", pending, all: [] }))).toEqual(["b"]);
  });
});

describe("countPendingByAgent", () => {
  it("counts only what is waiting, per agent", () => {
    expect(
      countPendingByAgent([
        checkIn("1", { agentId: "x" }),
        checkIn("2", { agentId: "x" }),
        checkIn("3", { agentId: "y" }),
        checkIn("4", { agentId: "y", status: "approved" }),
      ]),
    ).toEqual({ x: 2, y: 1 });
  });
});

describe("checkInsWaitingLabel", () => {
  it("reads naturally for one and many", () => {
    expect(checkInsWaitingLabel(1)).toBe("1 Check-In Waiting");
    expect(checkInsWaitingLabel(3)).toBe("3 Check-Ins Waiting");
  });

  it("marks a count that stops at the first page", () => {
    expect(checkInsWaitingLabel(50, true)).toBe("50+ Check-Ins Waiting");
  });
});

describe("goalTitleFor", () => {
  const agents = [
    {
      profile: { id: "agent-1" },
      goals: [{ id: "goal-1", title: "Keep the inbox clear" }],
    },
    { profile: { id: "agent-2" } },
  ] as unknown as WorkspaceAgent[];

  it("finds the goal's title", () => {
    expect(goalTitleFor(agents, { agentId: "agent-1", goalId: "goal-1" })).toBe(
      "Keep the inbox clear",
    );
  });

  it("is null once the goal is deleted, or the agent has no goals", () => {
    expect(goalTitleFor(agents, { agentId: "agent-1", goalId: "gone" })).toBeNull();
    expect(goalTitleFor(agents, { agentId: "agent-2", goalId: "goal-1" })).toBeNull();
    expect(goalTitleFor(agents, { agentId: "missing", goalId: "goal-1" })).toBeNull();
  });
});

describe("checkRedirectNote", () => {
  it("needs words, and trims them", () => {
    expect(checkRedirectNote("   \n ")).toEqual({ ok: false });
    expect(checkRedirectNote("  Try the other branch  ")).toEqual({
      ok: true,
      note: "Try the other branch",
    });
  });
});
