import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentBoard,
  summarizeAgentBoard,
  type AgentBoardAgent,
  type AgentBoardThread,
} from "./agentBoard";

const LOCAL = "env-local" as EnvironmentId;
const REMOTE = "env-remote" as EnvironmentId;

type Overrides = Partial<AgentBoardThread> & { runtimeStatus?: string; errorClass?: string };

function thread(id: string, overrides: Overrides = {}): AgentBoardThread {
  const { runtimeStatus = "completed", errorClass, ...rest } = overrides;
  return {
    environmentId: LOCAL,
    id,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestRun: null,
    runtime: {
      status: runtimeStatus,
      activeRunId: null,
      providerInstanceId: "codex",
      providerName: null,
      lastError: null,
      lastErrorClass: errorClass ?? null,
      updatedAt: rest.updatedAt ?? "2026-10-01T00:00:00.000Z",
    },
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    ...rest,
  } as unknown as AgentBoardThread;
}

const agent = (id: string, name = id, primaryThreadId: string | null = `t-${id}`) => ({
  id,
  name,
  primaryThreadId,
});

function board(
  agents: AgentBoardAgent[],
  threads: AgentBoardThread[],
  extra: Partial<Parameters<typeof buildAgentBoard>[0]> = {},
) {
  return buildAgentBoard({
    agents,
    threads,
    workspaceEnvironmentId: LOCAL,
    localEnvironmentId: LOCAL,
    ...extra,
  });
}

describe("buildAgentBoard status", () => {
  it("marks a pending approval, a question and a plan to review as Needs You", () => {
    const entries = board(
      [agent("a"), agent("b"), agent("c")],
      [
        thread("t-a", { hasPendingApprovals: true }),
        thread("t-b", { hasPendingUserInput: true }),
        thread("t-c", {
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          latestRun: {
            runId: "run-1",
            status: "completed",
            requestedAt: null,
            startedAt: null,
            completedAt: "2026-10-01T00:00:00.000Z",
            assistantMessageId: null,
          },
        } as Overrides),
      ],
    );
    expect(entries.map((e) => [e.agent.id, e.status, e.need]).toSorted()).toEqual([
      ["a", "needs-you", "approval"],
      ["b", "needs-you", "input"],
      ["c", "needs-you", "plan"],
    ]);
  });

  it("keeps a proposed plan on a default-mode thread Idle", () => {
    const [entry] = board([agent("a")], [thread("t-a", { hasActionableProposedPlan: true })]);
    expect(entry?.status).toBe("idle");
  });

  it("reads a running turn, a waiting turn and a thread parked on background tasks as Working", () => {
    const entries = board(
      [agent("a"), agent("b"), agent("c")],
      [
        thread("t-a", { runtimeStatus: "running" }),
        thread("t-b", { runtimeStatus: "waiting" }),
        thread("t-c", { runtimeStatus: "idle" }),
      ],
    );
    expect(entries.map((e) => e.status)).toEqual(["working", "working", "working"]);
  });

  it("reads a failed run as Failed and a usage limit as Limited", () => {
    const entries = board(
      [agent("a"), agent("b")],
      [
        thread("t-a", { runtimeStatus: "failed" }),
        thread("t-b", { runtimeStatus: "failed", errorClass: "usage_limit" }),
      ],
    );
    expect(entries.map((e) => [e.agent.id, e.status])).toEqual([
      ["a", "failed"],
      ["b", "limited"],
    ]);
  });

  it("reads a stopped thread as Idle", () => {
    const [entry] = board([agent("a")], [thread("t-a")]);
    expect(entry?.status).toBe("idle");
  });

  it("reads an agent with no conversation as Not Started", () => {
    const [entry] = board([agent("a", "A", null)], []);
    expect(entry).toMatchObject({
      status: "not-started",
      lastActivityAt: null,
      remoteEnvironmentId: null,
    });
  });

  it("does not call an agent Not Started because its thread has not loaded yet", () => {
    const [entry] = board([agent("a")], []);
    expect(entry).toMatchObject({ status: "idle", lastActivityAt: null });
  });
});

describe("buildAgentBoard conversation", () => {
  it("prefers the live conversation and names its machine when it is not this device", () => {
    const [entry] = board(
      [agent("a")],
      [
        thread("t-a", { runtimeStatus: "failed" }),
        thread("live-a", { environmentId: REMOTE, runtimeStatus: "running" }),
      ],
      { live: { a: { environmentId: REMOTE, threadId: "live-a" } } },
    );
    expect(entry).toMatchObject({ status: "working", remoteEnvironmentId: REMOTE });
  });

  it("falls back to the primary thread when the live thread is not loaded", () => {
    const [entry] = board([agent("a")], [thread("t-a", { runtimeStatus: "running" })], {
      live: { a: { environmentId: REMOTE, threadId: "live-a" } },
    });
    expect(entry?.status).toBe("working");
    expect(entry?.remoteEnvironmentId).toBeNull();
  });

  it("names the workspace machine when it is another environment", () => {
    const [entry] = board([agent("a")], [thread("t-a", { environmentId: REMOTE })], {
      workspaceEnvironmentId: REMOTE,
    });
    expect(entry?.remoteEnvironmentId).toBe(REMOTE);
  });

  it("uses the newest of the thread's timestamps as last activity", () => {
    const [entry] = board(
      [agent("a")],
      [
        thread("t-a", {
          updatedAt: "2026-10-01T00:00:00.000Z",
          latestUserMessageAt: "2026-10-02T00:00:00.000Z",
        }),
      ],
    );
    expect(entry?.lastActivityAt).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("buildAgentBoard ordering", () => {
  it("orders groups Needs You, Failed, Limited, Working, Idle, Not Started", () => {
    const entries = board(
      [
        agent("idle"),
        agent("none", "None", null),
        agent("limited"),
        agent("working"),
        agent("failed"),
        agent("needs"),
      ],
      [
        thread("t-idle"),
        thread("t-limited", { runtimeStatus: "failed", errorClass: "usage_limit" }),
        thread("t-working", { runtimeStatus: "running" }),
        thread("t-failed", { runtimeStatus: "failed" }),
        thread("t-needs", { hasPendingApprovals: true }),
      ],
    );
    expect(entries.map((e) => e.agent.id)).toEqual([
      "needs",
      "failed",
      "limited",
      "working",
      "idle",
      "none",
    ]);
  });

  it("puts the most recent activity first within a group, then sorts by name", () => {
    const entries = board(
      [agent("old", "Old"), agent("new", "New"), agent("tie-b", "Bea"), agent("tie-a", "Ann")],
      [
        thread("t-old", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        thread("t-new", { updatedAt: "2026-10-03T00:00:00.000Z" }),
        thread("t-tie-b", { updatedAt: "2026-09-01T00:00:00.000Z" }),
        thread("t-tie-a", { updatedAt: "2026-09-01T00:00:00.000Z" }),
      ],
    );
    expect(entries.map((e) => e.agent.id)).toEqual(["new", "old", "tie-a", "tie-b"]);
  });

  it("sinks an agent with unknown activity to the end of its group", () => {
    const entries = board([agent("unloaded"), agent("known")], [thread("t-known")]);
    expect(entries.map((e) => e.agent.id)).toEqual(["known", "unloaded"]);
  });
});

describe("buildAgentBoard check-ins", () => {
  it("carries each agent's waiting check-ins without changing the order", () => {
    const threads = [
      thread("t-quiet", { updatedAt: "2026-10-03T00:00:00.000Z" }),
      thread("t-busy", { updatedAt: "2026-10-01T00:00:00.000Z" }),
      thread("t-none", { updatedAt: "2026-10-02T00:00:00.000Z" }),
    ];
    const agents = [agent("quiet"), agent("busy"), agent("none", "none", null)];
    const plain = board(agents, threads);
    const counted = board(agents, threads, { pendingCheckIns: { busy: 3 } });
    expect(counted.map((e) => e.agent.id)).toEqual(plain.map((e) => e.agent.id));
    expect(counted.map((e) => [e.agent.id, e.pendingCheckIns]).toSorted()).toEqual([
      ["busy", 3],
      ["none", 0],
      ["quiet", 0],
    ]);
  });

  it("counts waiting check-ins for an agent that has not started or has not loaded", () => {
    const entries = board([agent("new", "new", null), agent("unloaded")], [], {
      pendingCheckIns: { new: 1, unloaded: 2 },
    });
    expect(entries.map((e) => [e.agent.id, e.pendingCheckIns]).toSorted()).toEqual([
      ["new", 1],
      ["unloaded", 2],
    ]);
  });
});

describe("summarizeAgentBoard", () => {
  it("counts each group and skips the empty ones", () => {
    const entries = board(
      [agent("a"), agent("b"), agent("c"), agent("d"), agent("e", "E", null)],
      [
        thread("t-a", { hasPendingApprovals: true }),
        thread("t-b", { hasPendingUserInput: true }),
        thread("t-c", { runtimeStatus: "running" }),
        thread("t-d", { runtimeStatus: "failed" }),
      ],
    );
    const summary = summarizeAgentBoard(entries);
    expect(summary.label).toBe("2 Need You · 1 Failed · 1 Working · 1 Not Started");
    expect(summary.counts.idle).toBe(0);
  });

  it("is empty when there are no agents", () => {
    expect(summarizeAgentBoard([]).label).toBe("");
  });
});

describe("buildAgentBoard quiet", () => {
  const nowMs = Date.parse("2026-03-09T10:30:00.000Z");
  const quiet = (id: string, overrides: Overrides = {}) =>
    thread(id, {
      runtimeStatus: "running",
      updatedAt: "2026-03-09T10:15:00.000Z",
      ...overrides,
    });

  it("reports minutes of silence for a working agent past ten minutes", () => {
    const [entry] = board([agent("a")], [quiet("t-a")], { nowMs });
    expect(entry?.status).toBe("working");
    expect(entry?.quietMinutes).toBe(15);
  });

  it("stays null when recent, not working, or no clock is given", () => {
    expect(
      board([agent("a")], [quiet("t-a", { updatedAt: "2026-03-09T10:25:00.000Z" })], { nowMs })[0]
        ?.quietMinutes,
    ).toBeNull();
    expect(board([agent("a")], [thread("t-a")], { nowMs })[0]?.quietMinutes).toBeNull();
    expect(board([agent("a")], [quiet("t-a")])[0]?.quietMinutes).toBeNull();
  });
});

describe("buildAgentBoard who asked whom", () => {
  const askedBy = (threadId: string) => ({ activeRunRequestedBy: { threadId } }) as Overrides;
  const byId = (entries: ReturnType<typeof board>) =>
    Object.fromEntries(entries.map((e) => [e.agent.id, e]));

  it("shows the asker on the working agent and the wait on the asker", () => {
    const entries = byId(
      board(
        [agent("a", "Alpha"), agent("b", "Beta")],
        [
          thread("t-a", { runtimeStatus: "running" }),
          thread("t-b", { runtimeStatus: "running", ...askedBy("t-a") }),
        ],
      ),
    );
    expect(entries.b?.askedBy).toBe("Alpha");
    expect(entries.b?.waitingOn).toEqual([]);
    expect(entries.a?.askedBy).toBeNull();
    expect(entries.a?.waitingOn).toEqual(["Beta"]);
  });

  it("lists every agent working on the asker's messages, by name", () => {
    const entries = byId(
      board(
        [agent("a", "Alpha"), agent("b", "Beta"), agent("c", "Gamma")],
        [
          thread("t-a", { runtimeStatus: "running" }),
          thread("t-b", { runtimeStatus: "running", ...askedBy("t-a") }),
          thread("t-c", { runtimeStatus: "waiting", ...askedBy("t-a") }),
        ],
      ),
    );
    expect(entries.a?.waitingOn).toEqual(["Beta", "Gamma"]);
  });

  it("drops both once the asked agent has finished", () => {
    const entries = byId(
      board(
        [agent("a", "Alpha"), agent("b", "Beta")],
        [thread("t-a"), thread("t-b", { runtimeStatus: "completed", ...askedBy("t-a") })],
      ),
    );
    expect(entries.b?.askedBy).toBeNull();
    expect(entries.a?.waitingOn).toEqual([]);
  });

  it("says nothing when the requester is not an agent on the board, and never about itself", () => {
    const entries = byId(
      board(
        [agent("a", "Alpha"), agent("b", "Beta")],
        [
          thread("t-a", { runtimeStatus: "running", ...askedBy("t-a") }),
          thread("t-b", { runtimeStatus: "running", ...askedBy("t-stranger") }),
        ],
      ),
    );
    expect(entries.a?.askedBy).toBeNull();
    expect(entries.b?.askedBy).toBeNull();
    expect(entries.a?.waitingOn).toEqual([]);
  });

  it("resolves a message sent from a side thread of the asking agent", () => {
    const entries = byId(
      board(
        [{ ...agent("a", "Alpha"), threadIds: ["t-a", "t-a-side"] }, agent("b", "Beta")],
        [
          thread("t-a", { runtimeStatus: "running" }),
          thread("t-b", { runtimeStatus: "running", ...askedBy("t-a-side") }),
        ],
      ),
    );
    expect(entries.b?.askedBy).toBe("Alpha");
    expect(entries.a?.waitingOn).toEqual(["Beta"]);
  });
});
