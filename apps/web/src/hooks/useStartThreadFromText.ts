import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { resolveStartModelSelection } from "~/lib/startThreadFromText";
import { newMessageId, newThreadId } from "~/lib/utils";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useScratchProject } from "./useScratchProject";

/**
 * Starts a new thread without a project on the primary machine and sends
 * `text` as its first message, with no composer in between. Rejects with a
 * message fit to show the user.
 */
export function useStartThreadFromText() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const navigate = useNavigate();

  return useCallback(
    async (text: string): Promise<void> => {
      const message = text.trim();
      if (!message) throw new Error("Nothing was said.");
      const environmentId = scratchEnvironmentId(primaryEnvironmentId);
      if (environmentId === null) {
        throw new Error("This machine cannot start a thread without a project.");
      }
      const project = await openScratchProject(environmentId);
      // openScratchProject already told the user why.
      if (!project) throw new Error("Could not start without a project.");
      const config = serverConfigs.get(environmentId);
      const settings = resolveProjectSettings(
        config?.settings ?? DEFAULT_SERVER_SETTINGS,
        project.id,
        project,
      ).settings;
      const modelSelection = resolveStartModelSelection(
        settings.defaultModelSelection,
        deriveProviderInstanceEntries(config?.providers ?? []),
      );
      if (!modelSelection) throw new Error("Choose a default model in Settings first.");
      const threadId = newThreadId();
      const title = truncate(message);
      const started = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: message, attachments: [] },
          modelSelection,
          titleSeed: title,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode: settings.defaultRuntimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      if (started._tag === "Failure") throw new Error("The thread could not be started.");
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    },
    [
      navigate,
      openScratchProject,
      primaryEnvironmentId,
      scratchEnvironmentId,
      serverConfigs,
      startTurn,
    ],
  );
}
