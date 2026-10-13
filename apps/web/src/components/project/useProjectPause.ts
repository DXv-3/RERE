import { useState } from "react";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ThreadShell } from "../../types";
import { threadsToInterruptOnPause } from "./projectOverview";

/**
 * Pauses or resumes a project on every machine it lives on. Pausing first closes the door (the
 * server then refuses new messages and launches) and only then interrupts what is running, so
 * nothing can start in between. Returns an error message, or null when it worked.
 */
export function useProjectPause(): {
  readonly setPaused: (input: {
    readonly members: ReadonlyArray<SidebarProjectGroupMember>;
    readonly threads: ReadonlyArray<ThreadShell>;
    readonly paused: boolean;
  }) => Promise<string | null>;
  readonly busy: boolean;
} {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [busy, setBusy] = useState(false);

  const setPaused: ReturnType<typeof useProjectPause>["setPaused"] = async (input) => {
    setBusy(true);
    try {
      for (const member of input.members) {
        const result = await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, paused: input.paused },
        });
        if (result._tag === "Failure") {
          return `Could not ${input.paused ? "pause" : "resume"} the project on ${member.environmentLabel ?? "this machine"}.`;
        }
      }
      if (!input.paused) return null;
      let failed = 0;
      for (const thread of threadsToInterruptOnPause(input.threads)) {
        const result = await interrupt({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
        if (result._tag === "Failure") failed += 1;
      }
      return failed === 0
        ? null
        : `Paused, but ${failed} running ${failed === 1 ? "thread" : "threads"} could not be stopped. Open and stop ${failed === 1 ? "it" : "them"} by hand.`;
    } finally {
      setBusy(false);
    }
  };

  return { setPaused, busy };
}
