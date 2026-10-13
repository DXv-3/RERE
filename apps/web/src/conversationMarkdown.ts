import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

/** Above this many bytes the copy still happens, but the toast says it is large. */
export const CONVERSATION_COPY_WARN_BYTES = 2 * 1024 * 1024;

export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

// A skill stage Workbench attached to a message, and the agent profile it prefixes. Both are
// instructions for the model, not part of what the person wrote or the model answered.
const SKILL_BLOCK =
  /\[Workbench skill [a-z0-9-]+@[a-f0-9]{64} stage:[^\]]*\][\s\S]*?\[End Workbench skill\]/g;
const AGENT_BLOCK = /<workbench-agent>[\s\S]*?<\/workbench-agent>/g;

export function stripAttachedInstructions(text: string): string {
  return text.replace(AGENT_BLOCK, "").replace(SKILL_BLOCK, "").trim();
}

/**
 * The user and assistant messages of a thread in the order they were shown. Tool calls, reasoning,
 * plans and other items are left out, and so is any message that is empty once attached skill
 * blocks are removed.
 */
export function conversationMessagesFromItems(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<ConversationMessage> {
  const messages: ConversationMessage[] = [];
  for (const { item } of rows) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const text = stripAttachedInstructions(item.text);
    if (text.length === 0) continue;
    messages.push({ role: item.type === "user_message" ? "user" : "assistant", text });
  }
  return messages;
}

/** `## You` / `## <assistantLabel>` sections, one per message, in order. */
export function formatConversationMarkdown(input: {
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly assistantLabel: string;
}): { readonly markdown: string; readonly count: number; readonly bytes: number } {
  const markdown = input.messages
    .map(
      (message) =>
        `## ${message.role === "user" ? "You" : input.assistantLabel}\n\n${message.text}`,
    )
    .join("\n\n");
  return {
    markdown,
    count: input.messages.length,
    bytes: new TextEncoder().encode(markdown).length,
  };
}

export function copiedMessagesTitle(count: number): string {
  return `Copied ${count} ${count === 1 ? "message" : "messages"}`;
}
