import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { sessionKey, useWorkbenchPreferences } from "../components/workbench/workbenchPreferences";
import {
  CONVERSATION_COPY_WARN_BYTES,
  conversationMessagesFromItems,
  copiedMessagesTitle,
  formatConversationMarkdown,
} from "../conversationMarkdown";
import { readThreadHistory, readThreadProjection, readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "./useCopyToClipboard";

// Each page is a bounded window of turns, so this is a safety stop rather than a limit anyone meets.
const MAX_HISTORY_PAGES = 500;
const MAX_BUSY_RETRIES = 20;
const BUSY_RETRY_MS = 150;

/**
 * Copies a whole thread as Markdown. The screen only holds the newest window of a long thread, so
 * this first pages the older history in (the same command the "Load earlier" control uses) and then
 * reads every message. The thread must be the one open on screen: paging needs its history
 * controller, which only exists while the thread is mounted.
 */
export function useCopyConversation() {
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const fail = (description: string) =>
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Could not copy conversation", description }),
        );
      let pages = 0;
      let busyRetries = 0;
      let paged = true;
      while (readThreadHistory(threadRef).hasMoreHistory) {
        if (pages >= MAX_HISTORY_PAGES) {
          paged = false;
          break;
        }
        const result = await loadEarlier({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          fail(error instanceof Error ? error.message : "Older messages could not be loaded.");
          return;
        }
        if (result.value._tag === "busy") {
          // Another load of this thread is in flight; wait for it and look again.
          if (++busyRetries > MAX_BUSY_RETRIES) {
            paged = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
          continue;
        }
        if (result.value._tag !== "loaded") {
          paged = false;
          break;
        }
        pages += 1;
      }
      const projection = readThreadProjection(threadRef)?.projection;
      if (!projection) {
        fail("This thread has not loaded yet.");
        return;
      }
      const preferences = useWorkbenchPreferences.getState();
      const agentId =
        preferences.assignments[sessionKey(threadRef.environmentId, threadRef.threadId)];
      const shell = readThreadShell(threadRef);
      const assistantLabel =
        preferences.agents.find((agent) => agent.id === agentId)?.name ??
        shell?.latestRun?.answeringModel ??
        shell?.modelSelection?.model ??
        "Assistant";
      const { markdown, count, bytes } = formatConversationMarkdown({
        messages: conversationMessagesFromItems(projection.visibleTurnItems),
        assistantLabel,
      });
      if (count === 0) {
        toastManager.add({ type: "warning", title: "Nothing to copy yet" });
        return;
      }
      try {
        if (!(await writeTextToClipboard(markdown, "conversation"))) return;
      } catch (error) {
        fail(error instanceof Error ? error.message : "An error occurred.");
        return;
      }
      const megabytes = (bytes / (1024 * 1024)).toFixed(1);
      const notes = [
        bytes > CONVERSATION_COPY_WARN_BYTES ? `This is large (${megabytes} MB).` : null,
        paged ? null : "Older messages could not be loaded, so the start is missing.",
      ].filter((note) => note !== null);
      toastManager.add({
        type: notes.length > 0 ? "warning" : "success",
        title: copiedMessagesTitle(count),
        ...(notes.length > 0 ? { description: notes.join(" ") } : {}),
      });
    },
    [loadEarlier],
  );
}
