import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  notificationBody,
  notificationProjectKey,
  notificationProjectTitles,
  threadNotificationKind,
  threadShellNotificationText,
} from "./threadNotificationCopy";

const shell = (
  runtime: { lastError?: string | null; usageLimitResetAt?: string | null } | null,
  latestVisibleMessage: { role: "assistant" | "user"; text: string } | null = null,
) =>
  ({
    runtime: runtime && { lastError: null, usageLimitResetAt: null, ...runtime },
    source: { latestVisibleMessage },
  }) as unknown as Pick<EnvironmentThreadShell, "runtime" | "source">;

describe("threadNotificationKind", () => {
  it("maps what the sidebar shows to what a notification says", () => {
    expect(threadNotificationKind("input", false)).toBe("waiting_for_input");
    expect(threadNotificationKind("approval", false)).toBe("waiting_for_approval");
    expect(threadNotificationKind("failed", false)).toBe("failed");
    expect(threadNotificationKind("limited", false)).toBe("limited");
    expect(threadNotificationKind("ready", true)).toBe("completed");
    expect(threadNotificationKind("working", false)).toBeNull();
  });
});

describe("notificationBody", () => {
  it("shows only the label when there is nothing the agent said", () => {
    expect(notificationBody(threadShellNotificationText(shell(null), "completed"))).toBe(
      "Finished",
    );
  });

  it("adds the agent's words when the shell carries them", () => {
    expect(
      notificationBody(
        threadShellNotificationText(
          shell(null, { role: "assistant", text: "Added the **retry** logic." }),
          "completed",
        ),
      ),
    ).toBe("Finished · Added the retry logic.");
  });

  it("explains a failure from the thread's error", () => {
    expect(
      notificationBody(
        threadShellNotificationText(shell({ lastError: "Rate limited by provider." }), "failed"),
      ),
    ).toBe("Failed · Rate limited by provider.");
  });

  it("ignores a user message as the agent's words", () => {
    expect(
      notificationBody(
        threadShellNotificationText(shell(null, { role: "user", text: "please fix" }), "completed"),
      ),
    ).toBe("Finished");
  });
});

describe("notificationProjectTitles", () => {
  const project = (id: string, title: string, workspaceRoot: string, environmentId = "env-1") => ({
    environmentId: environmentId as EnvironmentId,
    id: id as ProjectId,
    title,
    workspaceRoot,
  });
  const key = (id: string, environmentId = "env-1") =>
    notificationProjectKey(environmentId as EnvironmentId, id as ProjectId);

  it("never offers the Scratch project's folder name", () => {
    const titles = notificationProjectTitles(
      [
        project("p-scratch", "scratch", "/home/me/.t3/scratch"),
        project("p-app", "workbench", "/home/me/code/workbench"),
      ],
      () => "/home/me/.t3/scratch",
    );
    expect(titles.has(key("p-scratch"))).toBe(false);
    expect(titles.get(key("p-app"))).toBe("workbench");
  });

  it("keeps every title for an environment without a Scratch folder", () => {
    const titles = notificationProjectTitles(
      [project("p-scratch", "scratch", "/home/me/.t3/scratch")],
      () => undefined,
    );
    expect(titles.get(key("p-scratch"))).toBe("scratch");
  });

  it("matches the Scratch folder per environment", () => {
    const titles = notificationProjectTitles(
      [
        project("p", "scratch", "/a/scratch", "env-1"),
        project("p", "scratch", "/b/scratch", "env-2"),
      ],
      (environmentId) => (environmentId === "env-1" ? "/a/scratch/" : "/elsewhere"),
    );
    expect(titles.has(key("p", "env-1"))).toBe(false);
    expect(titles.has(key("p", "env-2"))).toBe(true);
  });
});
