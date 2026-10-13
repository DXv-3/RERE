import { expect, it } from "vite-plus/test";
import { cleanTranscript, DICTATION_PROMPT } from "./transcriptCleanup.ts";

it("drops whisper's non-speech tags", () => {
  for (const tag of [
    "[BLANK_AUDIO]",
    "[MUSIC]",
    "(silence)",
    "[ Silence ]",
    "(upbeat music)",
    "*applause*",
    "♪ ♪",
  ]) {
    expect(cleanTranscript(tag)).toBe("");
    expect(cleanTranscript(`Open the file ${tag} and run it.`)).toBe("Open the file and run it.");
  }
});

it("keeps parentheses that are part of what was said", () => {
  expect(cleanTranscript("Call the helper (the new one) first.")).toBe(
    "Call the helper (the new one) first.",
  );
});

it("joins whisper's lines into sentences", () => {
  expect(cleanTranscript(" Fix the login bug.\n  Then open a pull request .\n\n")).toBe(
    "Fix the login bug. Then open a pull request.",
  );
});

it("removes speaker-change markers and dialogue dashes", () => {
  expect(cleanTranscript(">> Please deploy it.\n>> Now.")).toBe("Please deploy it. Now.");
  expect(cleanTranscript("- Yes.\n- Go ahead.")).toBe("Yes. Go ahead.");
  expect(cleanTranscript("a -> b")).toBe("a -> b");
});

it("returns nothing when no speech is left", () => {
  expect(cleanTranscript("")).toBe("");
  expect(cleanTranscript("[BLANK_AUDIO]\n(silence)\n")).toBe("");
  expect(cleanTranscript(" . ")).toBe("");
});

it("treats an echoed prompt or a silence hallucination as no speech", () => {
  expect(cleanTranscript(DICTATION_PROMPT)).toBe("");
  expect(cleanTranscript(`${DICTATION_PROMPT} Ship it.`)).toBe("Ship it.");
  expect(cleanTranscript("Thanks for watching!")).toBe("");
  expect(cleanTranscript("you")).toBe("");
  expect(cleanTranscript("Thank you for the review, I will merge it.")).toBe(
    "Thank you for the review, I will merge it.",
  );
});
