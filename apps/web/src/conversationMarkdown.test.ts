import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  conversationMessagesFromItems,
  copiedMessagesTitle,
  formatConversationMarkdown,
  stripAttachedInstructions,
} from "./conversationMarkdown";

const row = (item: Record<string, unknown>) =>
  ({ item }) as unknown as OrchestrationV2ProjectedTurnItem;
const skill = `[Workbench skill workflow-guide@${"a".repeat(64)} stage:plan]\nRequested permissions: none.\nBe careful.\n[End Workbench skill]`;

describe("stripAttachedInstructions", () => {
  it("removes skill blocks and the agent profile block", () => {
    expect(
      stripAttachedInstructions(
        `<workbench-agent>\nAgent: A\n</workbench-agent>\n\nHi\n\n${skill}`,
      ),
    ).toBe("Hi");
  });
});

describe("conversationMessagesFromItems", () => {
  it("keeps user and assistant messages in order and drops everything else", () => {
    const messages = conversationMessagesFromItems([
      row({ type: "user_message", text: `Fix it\n\n${skill}` }),
      row({ type: "reasoning", text: "thinking" }),
      row({ type: "tool_call", text: "ls" }),
      row({ type: "assistant_message", text: "Done." }),
      row({ type: "user_message", text: skill }),
    ]);
    expect(messages).toEqual([
      { role: "user", text: "Fix it" },
      { role: "assistant", text: "Done." },
    ]);
  });
});

describe("formatConversationMarkdown", () => {
  it("writes one section per message", () => {
    const result = formatConversationMarkdown({
      assistantLabel: "Claude Opus",
      messages: [
        { role: "user", text: "Hi" },
        { role: "assistant", text: "Hello" },
      ],
    });
    expect(result.markdown).toBe("## You\n\nHi\n\n## Claude Opus\n\nHello");
    expect(result.count).toBe(2);
    expect(result.bytes).toBe(result.markdown.length);
  });
  it("is empty for no messages", () => {
    expect(formatConversationMarkdown({ assistantLabel: "x", messages: [] })).toEqual({
      markdown: "",
      count: 0,
      bytes: 0,
    });
  });
});

describe("copiedMessagesTitle", () => {
  it("pluralises", () => {
    expect(copiedMessagesTitle(1)).toBe("Copied 1 message");
    expect(copiedMessagesTitle(12)).toBe("Copied 12 messages");
  });
});
