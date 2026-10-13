import type { RelayAgentActivityAggregateRow } from "@t3tools/contracts/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { alertAllowedForPhase, alertForActivityRows } from "./agentActivityAlerts.ts";
import { notificationForActivity } from "./agentActivityPayloads.ts";

const row = (
  overrides: Partial<RelayAgentActivityAggregateRow> = {},
): RelayAgentActivityAggregateRow => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "workbench",
  threadTitle: "Fix the build",
  modelTitle: "Claude",
  phase: "completed",
  status: "Done",
  updatedAt: "2026-10-05T12:00:00.000Z",
  deepLink: "/threads/env-1/thread-1",
  ...overrides,
});

describe("alert wording", () => {
  it.each([
    ["completed", "Finished · workbench"],
    ["failed", "Failed · workbench"],
    ["waiting_for_input", "Needs your answer · workbench"],
    ["waiting_for_approval", "Needs approval · workbench"],
  ] as const)("reads like the direct push for %s", (phase, body) => {
    expect(alertForActivityRows([row({ phase })])).toEqual({ title: "Fix the build", body });
    const notification = notificationForActivity(row({ phase }));
    expect(notification.title).toBe("Fix the build");
    expect(notification.body).toBe(body);
  });

  it("leaves the project out when it repeats the thread title or is blank", () => {
    for (const projectTitle of ["fix the build", "  Fix the build  ", "   "]) {
      const alert = alertForActivityRows([row({ projectTitle })]);
      expect(alert?.body).toBe("Finished");
      expect(notificationForActivity(row({ projectTitle })).body).toBe("Finished");
    }
  });

  it("never leaves a trailing colon or separator", () => {
    for (const phase of ["completed", "failed", "waiting_for_input"] as const) {
      const body = alertForActivityRows([row({ phase, projectTitle: " " })])?.body ?? "";
      expect(body).not.toMatch(/[:·]\s*$/);
    }
  });

  it("keeps the grouped alert unchanged", () => {
    expect(
      alertForActivityRows([
        row({ phase: "waiting_for_approval" }),
        row({
          threadId: ThreadId.make("thread-2"),
          threadTitle: "Other",
          phase: "waiting_for_approval",
        }),
      ]),
    ).toEqual({ title: "2 agents need attention", body: "Fix the build, Other" });
  });
});

describe("short completions", () => {
  const preferences = {
    liveActivitiesEnabled: false,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };

  it.each([
    [{}, 5, false],
    [{}, 60, true],
    [{}, undefined, true],
    [{ minRunSeconds: 0 }, 5, true],
    [{ minRunSeconds: 180 }, 120, false],
  ] as const)("completed with %j after %s seconds", (extra, seconds, allowed) => {
    expect(alertAllowedForPhase({ ...preferences, ...extra }, "completed", seconds)).toBe(allowed);
  });

  it("always lets a failure or question through", () => {
    for (const phase of ["failed", "waiting_for_input", "waiting_for_approval"]) {
      expect(alertAllowedForPhase({ ...preferences, minRunSeconds: 600 }, phase, 1)).toBe(true);
    }
  });
});
