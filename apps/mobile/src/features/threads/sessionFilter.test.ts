import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { matchesSessionFilter, type SessionFilter } from "../../lib/sessionFilter";
import { buildThreadListV2Items, getThreadListV2OrderedSection } from "./threadListV2";

const now = "2026-06-02T00:00:00.000Z";
const environmentId = EnvironmentId.make("one");
const otherEnvironmentId = EnvironmentId.make("two");
const projectId = ProjectId.make("project");
const approval = makeThreadShellFixture({
  environmentId,
  projectId,
  id: ThreadId.make("approval"),
  title: "Approval",
  hasPendingApprovals: true,
});
const answer = makeThreadShellFixture({
  environmentId,
  projectId,
  id: ThreadId.make("answer"),
  title: "Answer",
  hasPendingUserInput: true,
});
const plan = makeThreadShellFixture({
  environmentId,
  projectId,
  id: ThreadId.make("plan"),
  title: "Plan",
  hasActionableProposedPlan: true,
});
const idle = makeThreadShellFixture({
  environmentId,
  projectId,
  id: ThreadId.make("idle"),
  title: "Awaiting review: please answer",
});

function visible(threads: readonly (typeof approval)[], sessionFilter: SessionFilter) {
  return buildThreadListV2Items({
    threads,
    sessionFilter,
    environmentId: null,
    searchQuery: "",
    now,
  }).items.map(({ thread }) => thread.id);
}

describe("mobile session filters", () => {
  it("uses pending approvals, questions and actionable plans, independently of title or completion", () => {
    const threads = [approval, answer, plan, idle];
    expect(visible(threads, "all")).toHaveLength(4);
    expect(new Set(visible(threads, "needs-attention"))).toEqual(
      new Set([approval.id, answer.id, plan.id]),
    );
    expect(new Set(visible(threads, "awaiting-review"))).toEqual(new Set([approval.id, plan.id]));
    expect(visible(threads, "awaiting-answer")).toEqual([answer.id]);
    const both = { ...approval, hasPendingUserInput: true };
    expect(matchesSessionFilter(both, "awaiting-review")).toBe(true);
    expect(matchesSessionFilter(both, "awaiting-answer")).toBe(true);
  });

  it.each([
    "command",
    "file-read",
    "file-change",
    "permission",
    "mcp-elicitation",
    "user_input",
  ] as const)("removes resolved %s requests on the next canonical shell update", (kind) => {
    const source = makeRawThreadShell({
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("request"),
        kind,
        createdAt: DateTime.makeUnsafe(now),
      },
    });
    const pending = presentThreadShell(environmentId, source);
    expect(visible([pending], "needs-attention")).toEqual([pending.id]);
    expect(
      visible(
        [presentThreadShell(environmentId, { ...source, pendingRuntimeRequest: null })],
        "needs-attention",
      ),
    ).toEqual([]);
    expect(visible([], "needs-attention")).toEqual([]);
  });

  it("removes consumed plans and excludes archived, deleted and child sessions", () => {
    expect(visible([{ ...plan, hasActionableProposedPlan: false }], "awaiting-review")).toEqual([]);
    expect(
      visible(
        [
          { ...approval, archivedAt: now },
          { ...answer, deletedAt: now },
          { ...plan, lineage: { ...plan.lineage, relationshipToParent: "subagent" } },
        ],
        "needs-attention",
      ),
    ).toEqual([]);
  });

  it("keeps attention visible above collapsed shelves and returns resolved sessions to their shelves", () => {
    const threads = [approval, answer, plan].map((thread) => ({
      ...thread,
      settledOverride: "settled" as const,
      snoozedUntil: "2026-06-03T00:00:00.000Z",
      snoozedAt: now,
    }));
    const input = {
      threads,
      environmentId: null,
      searchQuery: "",
      now,
      settledLimit: 0,
      settledShelfExpanded: false,
      snoozedShelfExpanded: false,
    };
    for (const sessionFilter of ["all", "needs-attention"] as const) {
      const layout = buildThreadListV2Items({ ...input, sessionFilter });
      expect(layout.items).toHaveLength(3);
      expect(layout.items.every((item) => item.variant === "card" && !item.snoozed)).toBe(true);
      expect(layout.snoozedCount).toBe(0);
      expect(layout.settledCount).toBe(0);
    }
    expect(getThreadListV2OrderedSection({ threads, section: "active", now })).toHaveLength(3);
    const resolved = threads.map((thread) => ({
      ...thread,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    }));
    expect(buildThreadListV2Items({ ...input, threads: resolved }).snoozedCount).toBe(3);
    expect(buildThreadListV2Items({ ...input, threads: resolved }).items).toEqual([]);
    expect(
      buildThreadListV2Items({
        ...input,
        threads: resolved.map((thread) => ({ ...thread, snoozedUntil: null })),
      }).settledCount,
    ).toBe(3);
  });

  it("intersects attention with search, environment and project using scoped identities", () => {
    const remoteApproval = {
      ...approval,
      environmentId: otherEnvironmentId,
      title: "Search target",
    };
    const remoteAnswer = { ...answer, environmentId: otherEnvironmentId, title: "Search target" };
    const input = {
      threads: [
        approval,
        remoteApproval,
        remoteAnswer,
        {
          ...remoteApproval,
          id: ThreadId.make("other-project"),
          projectId: ProjectId.make("other"),
        },
      ],
      environmentId: null,
      searchQuery: "Search target",
      now,
      sessionFilter: "awaiting-review" as const,
      projectRefs: [
        { environmentId, projectId },
        { environmentId: otherEnvironmentId, projectId },
      ],
    };
    expect(
      buildThreadListV2Items(input).items.map(({ thread }) => [thread.environmentId, thread.id]),
    ).toEqual([[otherEnvironmentId, approval.id]]);
    expect(buildThreadListV2Items({ ...input, environmentId }).items).toEqual([]);
    expect(
      buildThreadListV2Items({ ...input, searchQuery: "", environmentId }).items.map(
        ({ thread }) => thread.id,
      ),
    ).toEqual([approval.id]);
    // A message-search hit never bypasses attention or project scoping.
    expect(
      buildThreadListV2Items({
        ...input,
        searchQuery: "message only",
        matchedThreadKeys: new Set([
          threadSearchMatchKey({ environmentId: otherEnvironmentId, threadId: approval.id }),
          threadSearchMatchKey({ environmentId: otherEnvironmentId, threadId: answer.id }),
        ]),
      }).items.map(({ thread }) => thread.id),
    ).toEqual([approval.id]);
    expect(
      buildThreadListV2Items({ ...input, projectRefs: [{ environmentId, projectId }] }).items,
    ).toEqual([]);
  });
});
