import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "lastError"
        | "latestRunStartedAt"
        | "latestRunCompletedAt"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    updatedAt,
    ...overrides,
  });

  it("projects V2 run state", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("reports how long a completed run took, and nothing for other phases", () => {
    const run = {
      latestRunStartedAt: DateTime.makeUnsafe("2026-05-22T11:57:00.000Z"),
      latestRunCompletedAt: DateTime.makeUnsafe(NOW),
    };
    const input = { environmentId: "env-1" as EnvironmentId, project };
    expect(
      projectThreadAwarenessV2({ ...input, thread: v2Thread({ status: "completed", ...run }) }),
    ).toMatchObject({ phase: "completed", runDurationSeconds: 180 });
    expect(
      projectThreadAwarenessV2({ ...input, thread: v2Thread({ status: "failed", ...run }) }),
    ).not.toHaveProperty("runDurationSeconds");
    expect(
      projectThreadAwarenessV2({ ...input, thread: v2Thread({ status: "completed" }) }),
    ).not.toHaveProperty("runDurationSeconds");
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not publish %s subagent activity",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: "parent" as ThreadId,
              relationshipToParent: "subagent",
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a monitor", "running", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("prioritizes V2 user-input requests", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Needs your answer" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("carries the agent's own words in detail when the caller has them", () => {
    const state = projectThreadAwarenessV2({
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
      assistantText: "Fixed the **flaky test**. It was a race in setup.",
    });
    expect(state).toMatchObject({
      phase: "completed",
      headline: "Finished",
      detail: "Fixed the flaky test. It was a race in setup.",
    });
  });

  it("falls back to a plain phrase when the reply is not available", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed" }),
      }),
    ).toMatchObject({ headline: "Finished", detail: "Reply ready" });
  });

  it("explains a failed run from its error", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "failed", lastError: "Provider rejected the request." }),
      }),
    ).toMatchObject({
      phase: "failed",
      headline: "Failed",
      detail: "Provider rejected the request.",
    });
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "failed" }),
      }),
    ).toMatchObject({ detail: "The run stopped with an error." });
  });

  it("does not add a detail while the agent is working", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
        assistantText: "Looking into it.",
      })?.detail,
    ).toBeUndefined();
  });

  it("shows the thread title instead of the Scratch project's folder name", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project: { title: "scratch" },
      thread: v2Thread({ status: "completed" }),
    };
    expect(projectThreadAwarenessV2(input)?.projectTitle).toBe("scratch");
    expect(projectThreadAwarenessV2({ ...input, projectIsScratch: true })?.projectTitle).toBe(
      "Integrate orchestration",
    );
  });
});
