import { EnvironmentId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectOverview,
  resolveProjectOverviewEntry,
  summarizeProjectOverview,
  threadsToInterruptOnPause,
  type ProjectOverviewThread,
} from "./projectOverview";

const pullRequest = (
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> = {},
  source: ThreadPullRequestLink["source"] = "agent",
): ThreadPullRequestLink =>
  ({
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    source,
    linkedAt: "2026-10-10T00:00:00.000Z",
    snapshot: { state: "open", isDraft: false, reviewDecision: null, ...snapshot },
    stack: null,
  }) as ThreadPullRequestLink;

const thread = (overrides: Record<string, unknown> = {}): ProjectOverviewThread =>
  ({
    environmentId: EnvironmentId.make("env"),
    id: ThreadId.make("t1"),
    title: "Fix login",
    archivedAt: null,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  }) as unknown as ProjectOverviewThread;

const running = { status: "running" };
const groupOf = (overrides: Record<string, unknown>) =>
  resolveProjectOverviewEntry(thread(overrides)).group;

describe("resolveProjectOverviewEntry", () => {
  it("puts a finished thread with nothing pending in Idle", () => {
    expect(groupOf({})).toBe("idle");
  });

  it("puts anything the user must act on in Waiting On You, with the reason", () => {
    expect(resolveProjectOverviewEntry(thread({ hasPendingApprovals: true }))).toMatchObject({
      group: "waiting",
      need: "approval",
    });
    expect(resolveProjectOverviewEntry(thread({ hasPendingUserInput: true })).need).toBe("input");
    expect(
      resolveProjectOverviewEntry(thread({ runtime: { status: "failed", lastErrorClass: null } }))
        .need,
    ).toBe("failed");
    expect(
      resolveProjectOverviewEntry(
        thread({ runtime: { status: "failed", lastErrorClass: "usage_limit" } }),
      ).need,
    ).toBe("limited");
  });

  it("keeps a running thread in Working even when its pull request is open or it was settled", () => {
    expect(groupOf({ runtime: running })).toBe("working");
    expect(groupOf({ runtime: running, pullRequests: [pullRequest()] })).toBe("working");
    expect(groupOf({ runtime: running, settledOverride: "settled" })).toBe("working");
  });

  it("puts an idle thread with an open, non-draft pull request in Ready For Review", () => {
    const entry = resolveProjectOverviewEntry(thread({ pullRequests: [pullRequest()] }));
    expect(entry.group).toBe("review");
    expect(entry.pullRequest?.number).toBe(7);
  });

  it("does not ask for review of a draft, a closed or a dismissed pull request", () => {
    expect(groupOf({ pullRequests: [pullRequest({ isDraft: true })] })).toBe("idle");
    expect(groupOf({ pullRequests: [pullRequest({ state: "merged" })] })).toBe("idle");
    expect(groupOf({ pullRequests: [pullRequest({}, "stack-dismissed")] })).toBe("idle");
  });

  it("puts an approved pull request in Landing", () => {
    expect(groupOf({ pullRequests: [pullRequest({ reviewDecision: "approved" })] })).toBe(
      "landing",
    );
  });

  it("treats a thread the user settled as Resolved even with an open pull request", () => {
    expect(groupOf({ settledOverride: "settled", pullRequests: [pullRequest()] })).toBe("resolved");
  });
});

describe("buildProjectOverview", () => {
  it("leaves out archived threads, subagents and the coordinator, newest first in a group", () => {
    const groups = buildProjectOverview({
      coordinatorThreadIds: new Set(["coordinator"]),
      threads: [
        thread({ id: "old", title: "Old", updatedAt: "2026-10-01T00:00:00.000Z" }),
        thread({ id: "new", title: "New", updatedAt: "2026-10-09T00:00:00.000Z" }),
        thread({ id: "gone", archivedAt: "2026-10-02T00:00:00.000Z" }),
        thread({ id: "child", lineage: { relationshipToParent: "subagent" } }),
        thread({ id: "coordinator" }),
        thread({ id: "busy", runtime: running }),
      ],
    });
    expect(groups.idle.map((entry) => entry.thread.id)).toEqual(["new", "old"]);
    expect(groups.working.map((entry) => entry.thread.id)).toEqual(["busy"]);
    expect(summarizeProjectOverview(groups)).toBe("1 Working · 2 Idle");
  });

  it("summarizes an empty project as nothing", () => {
    expect(summarizeProjectOverview(buildProjectOverview({ threads: [] }))).toBe("");
  });
});

describe("threadsToInterruptOnPause", () => {
  it("stops everything with a live run, and nothing else", () => {
    const stopped = threadsToInterruptOnPause([
      thread({ id: "running", runtime: running }),
      thread({ id: "asking", hasPendingUserInput: true }),
      thread({ id: "approving", hasPendingApprovals: true }),
      thread({ id: "idle" }),
      thread({ id: "failed", runtime: { status: "failed", lastErrorClass: null } }),
      thread({ id: "archived", runtime: running, archivedAt: "2026-10-02T00:00:00.000Z" }),
      thread({ id: "child", runtime: running, lineage: { relationshipToParent: "subagent" } }),
    ]);
    expect(stopped.map((entry) => entry.id)).toEqual(["running", "asking", "approving"]);
  });
});
