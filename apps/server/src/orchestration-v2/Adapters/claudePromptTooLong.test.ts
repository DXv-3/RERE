import { describe, expect, it } from "vite-plus/test";

import { isPromptTooLongResult } from "./claudePromptTooLong.ts";

describe("isPromptTooLongResult", () => {
  it("recognises the terminal reason, the result text and a listed error", () => {
    expect(isPromptTooLongResult({ terminal_reason: "prompt_too_long" })).toBe(true);
    expect(isPromptTooLongResult({ terminal_reason: null, result: "Prompt is too long" })).toBe(
      true,
    );
    expect(
      isPromptTooLongResult({ errors: ["API Error: prompt is too long: 210000 tokens"] }),
    ).toBe(true);
  });

  it("leaves limits and other failures alone", () => {
    expect(isPromptTooLongResult({ terminal_reason: "blocking_limit" })).toBe(false);
    expect(isPromptTooLongResult({ result: "Claude usage limit reached" })).toBe(false);
    expect(isPromptTooLongResult({ result: "Summarise why the prompt was long" })).toBe(false);
    expect(isPromptTooLongResult({})).toBe(false);
  });
});
