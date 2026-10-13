import { describe, expect, it } from "vite-plus/test";

import {
  countSidebarThreadsByFilter,
  filterSidebarThreadsByStatus,
  resolveSidebarThreadFilterBucket,
} from "./threadStatusFilter";

type Input = Parameters<typeof resolveSidebarThreadFilterBucket>[0];

const thread = (overrides: Partial<Input> & { name?: string }): Input & { name?: string } =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    latestRun: null,
    ...overrides,
  }) as never;

const running = thread({ name: "running", runtime: { status: "running" } as never });
const approval = thread({ name: "approval", hasPendingApprovals: true });
const asking = thread({ name: "asking", hasPendingUserInput: true });
const failed = thread({ name: "failed", runtime: { status: "failed" } as never });
const limited = thread({
  name: "limited",
  runtime: { status: "failed", lastErrorClass: "usage_limit" } as never,
});
const done = thread({ name: "done", latestRun: { status: "completed" } as never });
const fresh = thread({ name: "fresh" });
const idle = thread({ name: "idle", runtime: { status: "idle" } as never });

describe("sidebar thread status filter", () => {
  it("buckets each status", () => {
    expect(resolveSidebarThreadFilterBucket(running)).toBe("running");
    for (const t of [approval, asking, failed, limited]) {
      expect(resolveSidebarThreadFilterBucket(t)).toBe("needs-me");
    }
    expect(resolveSidebarThreadFilterBucket(done)).toBe("done");
    expect(resolveSidebarThreadFilterBucket(fresh)).toBeNull();
    expect(resolveSidebarThreadFilterBucket(idle)).toBeNull();
  });

  it("counts in one pass", () => {
    expect(
      countSidebarThreadsByFilter([running, approval, asking, failed, limited, done, fresh, idle]),
    ).toEqual({ all: 8, running: 1, "needs-me": 4, done: 1 });
  });

  it("filters, and returns the same array for All", () => {
    const all = [running, done, approval];
    expect(filterSidebarThreadsByStatus(all, "all")).toBe(all);
    expect(filterSidebarThreadsByStatus(all, "running")).toEqual([running]);
    expect(filterSidebarThreadsByStatus(all, "needs-me")).toEqual([approval]);
    expect(filterSidebarThreadsByStatus(all, "done")).toEqual([done]);
  });
});
