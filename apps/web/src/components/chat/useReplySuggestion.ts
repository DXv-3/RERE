import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage, SessionPhase } from "../../types";
import {
  createReplySuggestionMemory,
  isRecentTurn,
  isReplySuggestionCurrent,
  readReplySuggestion,
  shouldRequestReplySuggestion,
} from "./replySuggestion.logic";

const answered = createReplySuggestionMemory(200);

/**
 * The composer's ghost-text reply. In a server thread whose last turn is finished and whose draft
 * is empty, asks the server once for a predicted next message. The result is text to show and nothing
 * more: accepting it is the caller's job, and nothing here sends. Failures are silent.
 * `dismiss` drops the suggestion for this turn, and it stays gone on coming back to the thread.
 */
export function useReplySuggestion(input: {
  enabled: boolean;
  environmentId: EnvironmentId;
  /** The server thread, or null for a local draft. */
  threadId: ThreadId | null;
  phase: SessionPhase;
  draftEmpty: boolean;
  lastMessage: ChatMessage | undefined;
}): { readonly text: string | null; readonly dismiss: () => void } {
  const { enabled, environmentId, threadId, phase, draftEmpty, lastMessage } = input;
  const suggestReply = useAtomCommand(serverEnvironment.suggestReply, { reportFailure: false });
  const [suggestion, setSuggestion] = useState<{ messageId: MessageId; text: string } | null>(null);
  const turnFinishedRef = useRef(false);
  const wasRunningRef = useRef(false);
  const requestedForRef = useRef<MessageId | null>(null);
  // Bumped whenever an in-flight answer stops being wanted: thread switch, new turn, unmount.
  const generationRef = useRef(0);

  const resetKey = `${environmentId}:${threadId ?? ""}`;
  useEffect(() => {
    turnFinishedRef.current = false;
    wasRunningRef.current = false;
    requestedForRef.current = null;
    setSuggestion(null);
    return () => {
      generationRef.current += 1;
    };
  }, [resetKey]);

  useEffect(() => {
    if (phase === "running") {
      wasRunningRef.current = true;
      turnFinishedRef.current = false;
      generationRef.current += 1;
      setSuggestion(null);
    } else if (phase === "ready" && wasRunningRef.current) {
      wasRunningRef.current = false;
      turnFinishedRef.current = true;
    }
  }, [phase]);

  useEffect(() => {
    if (!draftEmpty) setSuggestion(null);
  }, [draftEmpty]);

  useEffect(() => {
    if (
      threadId === null ||
      !shouldRequestReplySuggestion({
        enabled,
        isServerThread: true,
        phase,
        turnFinished: turnFinishedRef.current,
        openedOnRecentTurn: isRecentTurn(lastMessage?.updatedAt, Date.now()),
        draftEmpty,
        lastMessage,
        requestedFor: requestedForRef.current,
      }) ||
      lastMessage === undefined
    ) {
      return;
    }
    const messageId = lastMessage.id;
    requestedForRef.current = messageId;
    turnFinishedRef.current = false;
    const answerKey = `${environmentId}:${threadId}:${messageId}`;
    if (answered.has(answerKey)) {
      const known = answered.get(answerKey);
      if (known !== null) setSuggestion({ messageId, text: known });
      return;
    }
    const generation = ++generationRef.current;
    void suggestReply({ environmentId, input: { threadId } }).then(
      (result) => {
        if (result._tag !== "Success") return;
        const text = readReplySuggestion(result.value.reply);
        // Kept even when the reader has moved on, so coming back shows it without asking again.
        answered.set(answerKey, text);
        if (generation !== generationRef.current) return;
        if (text !== null) setSuggestion({ messageId, text });
      },
      () => undefined,
    );
  }, [draftEmpty, enabled, environmentId, lastMessage, phase, suggestReply, threadId]);

  const current = isReplySuggestionCurrent({
    suggestion,
    draftEmpty,
    lastMessageId: lastMessage?.id,
    phase,
  });
  const dismiss = () => {
    if (suggestion === null || threadId === null) return;
    answered.set(`${environmentId}:${threadId}:${suggestion.messageId}`, null);
    setSuggestion(null);
  };
  return { text: current ? (suggestion?.text ?? null) : null, dismiss };
}
