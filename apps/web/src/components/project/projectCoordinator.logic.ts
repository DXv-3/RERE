import type { ThreadId } from "@t3tools/contracts";

import type { Project, ThreadShell } from "../../types";

export function coordinatorThreadTitle(projectTitle: string): string {
  return `${projectTitle} Coordinator`;
}

/**
 * The project's coordinator thread when it can still be opened. A coordinator the user
 * archived or deleted is treated as gone, so opening the project makes a fresh one.
 */
export function findLiveCoordinatorThreadId(
  project: Pick<Project, "environmentId" | "coordinatorThreadId">,
  threads: ReadonlyArray<Pick<ThreadShell, "environmentId" | "id" | "archivedAt">>,
): ThreadId | null {
  const coordinatorThreadId = project.coordinatorThreadId ?? null;
  if (coordinatorThreadId === null) return null;
  const thread = threads.find(
    (candidate) =>
      candidate.environmentId === project.environmentId && candidate.id === coordinatorThreadId,
  );
  return thread !== undefined && thread.archivedAt === null ? coordinatorThreadId : null;
}
