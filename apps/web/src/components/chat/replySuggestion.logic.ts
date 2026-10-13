import type { MessageId } from "@t3tools/contracts";

import type { ChatMessage, SessionPhase } from "../../types";

/** The server drops replies over this; the client checks again before showing one. */
const MAX_REPLY_SUGGESTION_CHARS = 120;

/** How old a finished turn may be and still get a suggestion when its thread is opened. */
const REPLY_SUGGESTION_MAX_TURN_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a message is recent enough to suggest a reply to on opening its thread. */
export function isRecentTurn(updatedAt: string | undefined, nowMs: number): boolean {
  if (updatedAt === undefined) return false;
  const at = Date.parse(updatedAt);
  return !Number.isNaN(at) && nowMs - at <= REPLY_SUGGESTION_MAX_TURN_AGE_MS;
}

/**
 * Whether the thread has a finished turn that still owes its suggestion. One request per
 * finished turn: `requestedFor` is the assistant message already asked about.
 */
export function shouldRequestReplySuggestion(input: {
  enabled: boolean;
  isServerThread: boolean;
  phase: SessionPhase;
  /** A run was seen going from running to idle since the last request or thread switch. */
  turnFinished: boolean;
  /**
   * The thread was opened with its last turn already finished, recently enough to still be
   * worth answering. Without this a suggestion only appeared for a run the user sat and watched.
   */
  openedOnRecentTurn: boolean;
  draftEmpty: boolean;
  lastMessage: Pick<ChatMessage, "id" | "role" | "streaming"> | undefined;
  requestedFor: MessageId | null;
}): boolean {
  return (
    input.enabled &&
    input.isServerThread &&
    input.phase === "ready" &&
    (input.turnFinished || input.openedOnRecentTurn) &&
    input.draftEmpty &&
    input.lastMessage?.role === "assistant" &&
    !input.lastMessage.streaming &&
    input.lastMessage.id !== input.requestedFor
  );
}

/** A reply fit to show as ghost text, or null. The server sanitizes; this is the last guard. */
export function readReplySuggestion(reply: string | null | undefined): string | null {
  const line = reply?.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 0 && line.length <= MAX_REPLY_SUGGESTION_CHARS ? line : null;
}

/**
 * Whether the suggestion may still be shown or accepted. It belongs to the turn it was made
 * for, so a new message in the thread, or any draft content, retires it.
 */
export function isReplySuggestionCurrent(input: {
  suggestion: { readonly messageId: MessageId } | null;
  draftEmpty: boolean;
  lastMessageId: MessageId | undefined;
  phase: SessionPhase;
}): boolean {
  return (
    input.suggestion !== null &&
    input.draftEmpty &&
    input.phase === "ready" &&
    input.suggestion.messageId === input.lastMessageId
  );
}

/**
 * One answer per assistant message for the life of the page, so moving between threads neither
 * asks again nor loses a suggestion already made. `null` records "asked, nothing to show":
 * either nothing usable came back, or the user dismissed it.
 */
export function createReplySuggestionMemory(limit: number) {
  const answers = new Map<string, string | null>();
  return {
    has: (key: string) => answers.has(key),
    get: (key: string) => answers.get(key) ?? null,
    set: (key: string, text: string | null) => {
      if (!answers.has(key) && answers.size >= limit) {
        const oldest = answers.keys().next().value;
        if (oldest !== undefined) answers.delete(oldest);
      }
      answers.set(key, text);
    },
  };
}
