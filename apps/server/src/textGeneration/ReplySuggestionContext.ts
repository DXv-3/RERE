import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

export type ReplySuggestionMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
};

const MAX_USER_CHARS = 1_500;
const MAX_ASSISTANT_CHARS = 3_000;
const MAX_VOICE_SAMPLES = 5;
const MAX_VOICE_SAMPLE_CHARS = 300;

/**
 * What to show the model, in conversation order, or null when there is nothing to answer:
 * the thread must end on a finished assistant message that follows a user message. The
 * assistant text keeps its end (where questions and next steps live); the user text keeps
 * its start (where the request is). `recentUserMessages` are the user's messages before the
 * latest one, oldest first: samples of how they write, not requests to answer.
 */
export function selectReplySuggestionContext(messages: ReadonlyArray<ReplySuggestionMessage>): {
  readonly lastUserMessage: string;
  readonly assistantTail: string;
  readonly recentUserMessages: ReadonlyArray<string>;
} | null {
  const conversation = messages.filter((message) => message.role !== "system");
  const last = conversation.at(-1);
  if (last === undefined || last.role !== "assistant" || last.streaming) return null;

  const assistantText = assistantCitationsToPlainText(last.text).trim();
  const lastUser = conversation.findLast((message) => message.role === "user");
  const userText = lastUser?.text.trim() ?? "";
  if (assistantText.length === 0 || userText.length === 0) return null;

  const recentUserMessages = conversation
    .filter((message) => message.role === "user" && message !== lastUser)
    .map((message) => message.text.replaceAll(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .slice(-MAX_VOICE_SAMPLES)
    .map((text) =>
      text.length <= MAX_VOICE_SAMPLE_CHARS ? text : `${text.slice(0, MAX_VOICE_SAMPLE_CHARS)}…`,
    );

  return {
    recentUserMessages,
    lastUserMessage:
      userText.length <= MAX_USER_CHARS ? userText : `${userText.slice(0, MAX_USER_CHARS)}…`,
    assistantTail:
      assistantText.length <= MAX_ASSISTANT_CHARS
        ? assistantText
        : `…${assistantText.slice(-MAX_ASSISTANT_CHARS)}`,
  };
}
