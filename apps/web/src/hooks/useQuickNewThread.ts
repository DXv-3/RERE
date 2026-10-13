import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useCallback } from "react";

import { resolveQuickNewThreadTarget } from "~/lib/chatThreadActions";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

/**
 * Opens a new thread straight away: in the project on screen, or without a
 * project when there is none. Resolves false when there is nowhere to start.
 */
export function useQuickNewThread() {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();

  return useCallback(async (): Promise<boolean> => {
    const current = activeThread ?? activeDraftThread;
    const currentProject = current
      ? projects.find(
          (project) =>
            project.environmentId === current.environmentId && project.id === current.projectId,
        )
      : undefined;
    const target = resolveQuickNewThreadTarget({
      currentProjectRef: current ? scopeProjectRef(current.environmentId, current.projectId) : null,
      currentProjectIsScratch:
        currentProject !== undefined &&
        isScratchProject(currentProject, scratchWorkspaceRootFor(currentProject.environmentId)),
      scratchEnvironmentId: scratchEnvironmentId(current?.environmentId ?? primaryEnvironmentId),
      defaultProjectRef,
    });
    if (target.kind === "none") return false;
    if (target.kind === "scratch") await startScratchThread(target.environmentId);
    else await handleNewThread(target.projectRef);
    return true;
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    primaryEnvironmentId,
    projects,
    scratchEnvironmentId,
    scratchWorkspaceRootFor,
    startScratchThread,
  ]);
}
