import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  assistantTextFromLatestMessage,
  threadNotificationText,
  type ThreadNotificationKind,
  type ThreadNotificationText,
} from "@t3tools/shared/threadNotificationText";

import type { SidebarThreadStatus } from "./components/Sidebar.logic";

/** The notification kind for a thread's sidebar status, or null when it needs no alert. */
export function threadNotificationKind(
  status: SidebarThreadStatus,
  completed: boolean,
): ThreadNotificationKind | null {
  if (completed) return "completed";
  switch (status) {
    case "input":
      return "waiting_for_input";
    case "approval":
      return "waiting_for_approval";
    case "failed":
      return "failed";
    case "limited":
      return "limited";
    case "ready":
    case "working":
    case "waiting":
      return null;
  }
}

/** Label and excerpt for a thread shell; the shell supplies the agent's words only if its server did. */
export function threadShellNotificationText(
  thread: Pick<EnvironmentThreadShell, "runtime" | "source">,
  kind: ThreadNotificationKind,
): ThreadNotificationText {
  return threadNotificationText(
    {
      kind,
      assistantText: assistantTextFromLatestMessage(thread.source.latestVisibleMessage),
      errorText: thread.runtime?.lastError,
      usageLimitResetAt: thread.runtime?.usageLimitResetAt,
    },
    { nowMs: Date.now() },
  );
}

/** One line for a toast or OS notification, under the thread title. */
export function notificationBody(text: ThreadNotificationText): string {
  return text.isFallback ? text.label : `${text.label} · ${text.excerpt}`;
}

export const notificationProjectKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  `${environmentId}:${projectId}`;

/**
 * Project names a notification may show, by `notificationProjectKey`. The
 * Scratch project is left out: its title is a folder name, not something the
 * user chose.
 */
export function notificationProjectTitles(
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">
  >,
  scratchWorkspaceRootFor: (environmentId: EnvironmentId) => string | null | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    projects
      .filter(
        (project) => !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
      )
      .map((project) => [notificationProjectKey(project.environmentId, project.id), project.title]),
  );
}

/**
 * Identifies one bell entry so reading it sticks until the thread has something
 * new to report. The bell and the coordinator must agree on this string.
 */
export function threadNotificationSignature(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "updatedAt">,
  status: SidebarThreadStatus,
): string {
  const at = thread.latestRun?.completedAt ?? thread.latestRun?.startedAt ?? thread.updatedAt;
  return `${thread.latestRun?.runId ?? ""}:${status}:${at}`;
}
