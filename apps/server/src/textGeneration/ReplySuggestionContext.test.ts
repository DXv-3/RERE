import { describe, expect, it } from "vite-plus/test";

import { selectReplySuggestionContext } from "./ReplySuggestionContext.ts";
import { buildReplySuggestionPrompt } from "./TextGenerationPrompts.ts";
import { sanitizeReplySuggestion } from "./TextGenerationUtils.ts";

const message = (role: "user" | "assistant" | "system", text: string, streaming = false) => ({
  role,
  text,
  streaming,
});

describe("selectReplySuggestionContext", () => {
  it("pairs the latest user message with the end of the final assistant message", () => {
    expect(
      selectReplySuggestionContext([
        message("user", "first"),
        message("assistant", "done"),
        message("user", "Add a settings toggle"),
        message("assistant", "Added it. Want me to add tests too?"),
      ]),
    ).toEqual({
      lastUserMessage: "Add a settings toggle",
      assistantTail: "Added it. Want me to add tests too?",
      recentUserMessages: ["first"],
    });
  });

  it("gives the user's earlier messages as bounded style samples, oldest first", () => {
    const context = selectReplySuggestionContext([
      ...Array.from({ length: 7 }, (_, index) => message("user", `msg ${index}`)),
      message("user", `long\n${"x".repeat(500)}`),
      message("assistant", "ok"),
      message("user", "latest"),
      message("assistant", "Done. Ship it?"),
    ]);
    expect(context?.lastUserMessage).toBe("latest");
    expect(context?.recentUserMessages).toHaveLength(5);
    expect(context?.recentUserMessages.slice(0, 4)).toEqual(["msg 3", "msg 4", "msg 5", "msg 6"]);
    expect(context?.recentUserMessages[4]?.startsWith("long x")).toBe(true);
    expect(context?.recentUserMessages[4]?.length).toBeLessThanOrEqual(301);
  });

  it("offers nothing while the assistant is still streaming or the user spoke last", () => {
    expect(
      selectReplySuggestionContext([message("user", "go"), message("assistant", "wor", true)]),
    ).toBeNull();
    expect(
      selectReplySuggestionContext([message("assistant", "Which one?"), message("user", "A")]),
    ).toBeNull();
  });

  it("offers nothing without a user message or assistant text", () => {
    expect(selectReplySuggestionContext([message("assistant", "Hello")])).toBeNull();
    expect(
      selectReplySuggestionContext([message("user", "go"), message("assistant", "  ")]),
    ).toBeNull();
    expect(selectReplySuggestionContext([])).toBeNull();
  });

  it("keeps the end of a long assistant message and the start of a long user message", () => {
    const context = selectReplySuggestionContext([
      message("user", `start${"u".repeat(5_000)}`),
      message("assistant", `${"a".repeat(5_000)}Should I continue?`),
    ]);
    expect(context?.assistantTail.endsWith("Should I continue?")).toBe(true);
    expect(context?.assistantTail.length).toBeLessThanOrEqual(3_001);
    expect(context?.lastUserMessage.startsWith("start")).toBe(true);
    expect(context?.lastUserMessage.length).toBeLessThanOrEqual(1_501);
  });
});

describe("buildReplySuggestionPrompt", () => {
  const base = { lastUserMessage: "add the toggle", assistantTail: "Added. Tests too?" };

  it("lists earlier user messages as a style reference ahead of the turn to answer", () => {
    const { prompt } = buildReplySuggestionPrompt({
      ...base,
      recentUserMessages: ["yep do it", "nah skip that"],
    });
    const style = prompt.indexOf("(style reference only):\n- yep do it\n- nah skip that");
    expect(style).toBeGreaterThan(-1);
    expect(style).toBeLessThan(prompt.indexOf("User's last message:\nadd the toggle"));
  });

  it("leaves the style section out when there are no earlier messages", () => {
    const { prompt } = buildReplySuggestionPrompt({ ...base, recentUserMessages: [] });
    expect(prompt).not.toContain("(style reference only):");
  });
});

describe("sanitizeReplySuggestion", () => {
  it("returns a clean single line", () => {
    expect(sanitizeReplySuggestion('  "Yes, add the tests."\nextra line')).toBe(
      "Yes, add the tests.",
    );
  });

  it("treats empty and placeholder answers as no suggestion", () => {
    for (const raw of ["", "   ", "None", "n/a.", "null", undefined, null]) {
      expect(sanitizeReplySuggestion(raw)).toBeNull();
    }
  });

  it("drops a reply too long to be a prompt instead of cutting it", () => {
    expect(sanitizeReplySuggestion("x".repeat(121))).toBeNull();
    expect(sanitizeReplySuggestion("x".repeat(120))).toBe("x".repeat(120));
  });
});
