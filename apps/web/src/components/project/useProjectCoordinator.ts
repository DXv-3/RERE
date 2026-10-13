import { type EnvironmentId, type ModelSelection, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { Project } from "../../types";
import { coordinatorThreadTitle, findLiveCoordinatorThreadId } from "./projectCoordinator.logic";

export type ProjectCoordinatorTarget = Pick<
  Project,
  "environmentId" | "id" | "title" | "coordinatorThreadId" | "defaultModelSelection"
>;

/**
 * Opens a project's coordinating conversation, creating it the first time. The coordinator is
 * an ordinary thread in the project's main checkout; the project records which one it is, and
 * the server gives that thread its role. Returns an error message, or null when it opened.
 */
export function useOpenProjectCoordinator(): {
  readonly open: (project: ProjectCoordinatorTarget) => Promise<string | null>;
  readonly opening: boolean;
} {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [opening, setOpening] = useState(false);

  const open = async (project: ProjectCoordinatorTarget): Promise<string | null> => {
    const environmentId: EnvironmentId = project.environmentId;
    const goTo = (threadId: ThreadId) =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });

    const existing = findLiveCoordinatorThreadId(project, threads);
    if (existing !== null) {
      await goTo(existing);
      return null;
    }

    const config = serverConfigs.get(environmentId);
    const defaultProvider = deriveProviderInstanceEntries(config?.providers ?? []).find(
      (entry) => entry.enabled && entry.isAvailable,
    );
    const defaultModel =
      defaultProvider?.models.find((model) => model.isDefault)?.slug ??
      defaultProvider?.models[0]?.slug;
    const modelSelection: ModelSelection | null =
      project.defaultModelSelection ??
      config?.settings.defaultModelSelection ??
      (defaultProvider && defaultModel
        ? { instanceId: defaultProvider.instanceId, model: defaultModel }
        : null);
    if (modelSelection === null) return "Set up a provider before opening a coordinator.";

    setOpening(true);
    try {
      const threadId = ThreadId.make(randomUUID());
      const created = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: project.id,
          title: coordinatorThreadTitle(project.title),
          modelSelection,
          // Starting worker threads needs a full-access caller in default mode.
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (created._tag === "Failure") return "Could not create the coordinator conversation.";
      const recorded = await updateProject({
        environmentId,
        input: { projectId: project.id, coordinatorThreadId: threadId },
      });
      if (recorded._tag === "Failure") {
        return "Created the conversation but could not make it this project's coordinator.";
      }
      await goTo(threadId);
      return null;
    } finally {
      setOpening(false);
    }
  };

  return { open, opening };
}
