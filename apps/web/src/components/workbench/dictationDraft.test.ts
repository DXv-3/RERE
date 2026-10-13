import { describe, expect, it } from "vite-plus/test";

import { applyDictatedText, withoutDictatedText } from "./dictationDraft";

describe("applyDictatedText", () => {
  it("appends to an existing draft and replaces its own earlier words", () => {
    const first = applyDictatedText(null, "1. guest camera", "council");
    expect(first.prompt).toBe("1. guest camera\ncouncil");
    expect(first.pendingFrom).toBe("1. guest camera\n".length);
    const second = applyDictatedText(first.session, first.prompt!, "council desk is next");
    expect(second.prompt).toBe("1. guest camera\ncouncil desk is next");
    expect(second.session.base).toBe("1. guest camera");
  });

  it("starts an empty draft without a leading line break", () => {
    const result = applyDictatedText(null, "", "hello there");
    expect(result.prompt).toBe("hello there");
    expect(result.pendingFrom).toBe(0);
  });

  it("keeps an edit made while recording and continues after it", () => {
    const first = applyDictatedText(null, "note", "one");
    const edited = "note!\none";
    const second = applyDictatedText(first.session, edited, "one two");
    expect(second.prompt).toBe("note!\none two");
  });

  it("detaches once the draft was sent, so sent words are not repeated", () => {
    const first = applyDictatedText(null, "", "send this");
    const afterSend = applyDictatedText(first.session, "", "send this and more");
    expect(afterSend.prompt).toBeNull();
    expect(afterSend.session.detached).toBe(true);
    expect(applyDictatedText(afterSend.session, "", "final words").prompt).toBeNull();
  });
});

describe("withoutDictatedText", () => {
  it("restores the earlier draft only while dictation still owns the text", () => {
    const { session, prompt } = applyDictatedText(null, "keep me", "drop me");
    expect(withoutDictatedText(session, prompt!)).toBe("keep me");
    expect(withoutDictatedText(session, `${prompt} edited`)).toBeNull();
  });
});
