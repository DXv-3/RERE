import { assert, describe, it } from "@effect/vitest";

import { buildGoalTurnPrompt } from "./goalPrompt.ts";

const goal = {
  id: "goal:1",
  title: "Keep the inbox clear",
  outcome: "No unanswered client email older than a day.",
  autonomy: "propose" as const,
};

describe("buildGoalTurnPrompt", () => {
  it("states the goal, the autonomy sentence, and ends on the report_checkin instruction", () => {
    const prompt = buildGoalTurnPrompt({ goal, previous: null, ownerNote: null });
    assert.include(prompt, "Goal: Keep the inbox clear");
    assert.include(prompt, "Outcome wanted: No unanswered client email older than a day.");
    assert.include(prompt, "change nothing");
    assert.notInclude(prompt, "previous check-in");
    assert.notInclude(prompt, "owner's latest note");
    const lastLine = prompt.split("\n").at(-1) ?? "";
    assert.include(lastLine, 'report_checkin tool with goalId "goal:1"');
  });

  it("words each autonomy level differently", () => {
    const sentence = (autonomy: "propose" | "act_and_report" | "act_freely") =>
      buildGoalTurnPrompt({ goal: { ...goal, autonomy }, previous: null, ownerNote: null })
        .split("\n")
        .find((line) => line.startsWith("How much to do:"));
    assert.include(sentence("act_and_report"), "within your normal permissions");
    assert.include(sentence("act_freely"), "Do whatever the goal needs");
    assert.equal(
      new Set(["propose", "act_and_report", "act_freely"].map((a) => sentence(a as never))).size,
      3,
    );
  });

  it("includes the previous check-in, what it asked for, and the owner's latest note", () => {
    const prompt = buildGoalTurnPrompt({
      goal,
      previous: {
        summary: "Replied to two clients.",
        needsFromOwner: "Which template to use for refunds?",
        createdAt: "2026-10-03T09:00:00.000Z",
      },
      ownerNote: "Use the short template.",
    });
    assert.include(
      prompt,
      "Your previous check-in (2026-10-03T09:00:00.000Z): Replied to two clients.",
    );
    assert.include(prompt, "You asked the owner for: Which template to use for refunds?");
    assert.include(prompt, "The owner's latest note: Use the short template.");
  });

  it("bounds a long previous summary", () => {
    const prompt = buildGoalTurnPrompt({
      goal,
      previous: {
        summary: "x".repeat(10_000),
        needsFromOwner: null,
        createdAt: "2026-10-03T09:00:00.000Z",
      },
      ownerNote: null,
    });
    assert.isBelow(prompt.length, 3_000);
    assert.include(prompt, "...");
  });
});
