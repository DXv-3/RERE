import { describe, expect, it } from "@effect/vitest";

import {
  assistantTextFromLatestMessage,
  meaningfulProjectTitle,
  notificationExcerpt,
  notificationSubtitle,
  threadNotificationText,
} from "./threadNotificationText.ts";

describe("notificationExcerpt", () => {
  it("returns an empty string when there is nothing to say", () => {
    expect(notificationExcerpt(null)).toBe("");
    expect(notificationExcerpt(undefined)).toBe("");
    expect(notificationExcerpt("   \n\n  ")).toBe("");
    expect(notificationExcerpt("```ts\nconst a = 1;\n```")).toBe("");
  });

  it("strips emphasis, code spans and links", () => {
    expect(
      notificationExcerpt(
        "I fixed **the build** by changing `vite.config.ts`, see [the PR](https://example.com/1) and _notes_.",
      ),
    ).toBe("I fixed the build by changing vite.config.ts, see the PR and notes.");
  });

  it("keeps snake_case identifiers and bare asterisks that are not emphasis", () => {
    expect(notificationExcerpt("Renamed my_var_name to other_name and ran 2 * 3.")).toBe(
      "Renamed my_var_name to other_name and ran 2 * 3.",
    );
  });

  it("drops fenced code blocks entirely, including unterminated ones", () => {
    expect(
      notificationExcerpt("Here is the patch.\n\n```diff\n- a\n+ b\n```\n\nThat is all."),
    ).toBe("Here is the patch. That is all.");
    expect(notificationExcerpt("Run this.\n~~~sh\nrm -rf build\nnpm test")).toBe("Run this.");
  });

  it("is not closed early by an info-string line inside a fence", () => {
    expect(notificationExcerpt("Before.\n````md\n```ts\ncode\n```\n````\nAfter.")).toBe(
      "Before. After.",
    );
  });

  it("turns headings and list items into short sentences", () => {
    expect(notificationExcerpt("## Summary\n- fixed the cache\n- added a test")).toBe(
      "Summary. fixed the cache.",
    );
    expect(notificationExcerpt("1. First step\n2. Second step")).toBe("First step. Second step.");
    expect(notificationExcerpt("- [x] done thing")).toBe("done thing.");
  });

  it("skips tables, rules and quote markers", () => {
    expect(
      notificationExcerpt("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\n> Note: it passes"),
    ).toBe("Note: it passes.");
  });

  it("removes html tags and image syntax", () => {
    expect(notificationExcerpt("<b>Done</b> ![diagram](x.png) with <br/> the change.")).toBe(
      "Done diagram with the change.",
    );
  });

  it("keeps up to two whole sentences that fit", () => {
    expect(notificationExcerpt("First sentence here. Second one follows. Third is dropped.")).toBe(
      "First sentence here. Second one follows.",
    );
  });

  it("keeps only the first sentence when two do not fit", () => {
    const first = "A".repeat(10) + " " + "b".repeat(100) + ".";
    expect(notificationExcerpt(`${first} ${"c".repeat(60)}.`)).toBe(first);
  });

  it("cuts a long single sentence on a word boundary with an ellipsis", () => {
    const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const excerpt = notificationExcerpt(text);
    expect(excerpt.length).toBeLessThanOrEqual(140);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.slice(0, -1).split(" ").at(-1)).toMatch(/^word\d+$/);
    expect(text.startsWith(excerpt.slice(0, -1))).toBe(true);
  });

  it("hard cuts a single unbroken token", () => {
    const excerpt = notificationExcerpt("x".repeat(500), 20);
    expect(excerpt).toBe(`${"x".repeat(19)}…`);
  });
});

describe("threadNotificationText", () => {
  it("labels a finished thread with the agent's last words", () => {
    expect(
      threadNotificationText({
        kind: "completed",
        assistantText: "All set. The **tests** pass now.\n\n```\nlog\n```",
      }),
    ).toEqual({ label: "Finished", excerpt: "All set. The tests pass now.", isFallback: false });
  });

  it("falls back to a plain phrase without assistant text", () => {
    expect(threadNotificationText({ kind: "completed" })).toEqual({
      label: "Finished",
      excerpt: "Reply ready",
      isFallback: true,
    });
    expect(
      threadNotificationText({ kind: "completed", assistantText: "```\nonly code\n```" }),
    ).toEqual({
      label: "Finished",
      excerpt: "Reply ready",
      isFallback: true,
    });
  });

  it("shows the cleaned error for a failed run", () => {
    expect(
      threadNotificationText({ kind: "failed", errorText: "Error: **Boom**\n  at foo (bar.ts:1)" }),
    ).toEqual({ label: "Failed", excerpt: "Error: Boom at foo (bar.ts:1)", isFallback: false });
  });

  it("does not show the agent's reply for a failed run without an error", () => {
    expect(threadNotificationText({ kind: "failed", assistantText: "Working on it." })).toEqual({
      label: "Failed",
      excerpt: "The run stopped with an error.",
      isFallback: true,
    });
    expect(threadNotificationText({ kind: "failed", errorText: "  " })).toEqual({
      label: "Failed",
      excerpt: "The run stopped with an error.",
      isFallback: true,
    });
  });

  it("uses the latest assistant text as the question or approval prompt", () => {
    expect(
      threadNotificationText({
        kind: "waiting_for_input",
        assistantText: "Which database should I use?",
      }),
    ).toEqual({
      label: "Needs your answer",
      excerpt: "Which database should I use?",
      isFallback: false,
    });
    expect(
      threadNotificationText({
        kind: "waiting_for_approval",
        assistantText: "I need to run `npm install`.",
      }),
    ).toEqual({
      label: "Needs approval",
      excerpt: "I need to run npm install.",
      isFallback: false,
    });
  });

  it("has a fallback for waiting phases without text", () => {
    expect(threadNotificationText({ kind: "waiting_for_input" }).excerpt).toBe(
      "The agent is waiting for your answer.",
    );
    expect(threadNotificationText({ kind: "waiting_for_approval" }).excerpt).toBe(
      "The agent is waiting for your approval.",
    );
  });

  it("reports the usage limit reset time when known", () => {
    const options = { locale: "en-US", timeZone: "UTC", nowMs: Date.parse("2026-10-05T10:00:00Z") };
    expect(
      threadNotificationText(
        { kind: "limited", usageLimitResetAt: "2026-10-05T15:30:00Z" },
        options,
      ),
    ).toEqual({ label: "Usage limit reached", excerpt: "Resets at 3:30 PM", isFallback: false });
    expect(
      threadNotificationText(
        { kind: "limited", usageLimitResetAt: "2026-10-08T15:30:00Z" },
        options,
      ).excerpt,
    ).toBe("Resets Thu at 3:30 PM");
    expect(
      threadNotificationText(
        { kind: "limited", usageLimitResetAt: "2026-10-05T15:30:00Z" },
        { locale: "en-US", timeZone: "UTC" },
      ).excerpt,
    ).toBe("Resets Mon at 3:30 PM");
    expect(threadNotificationText({ kind: "limited" }, options)).toEqual({
      label: "Usage limit reached",
      excerpt: "Try again later.",
      isFallback: true,
    });
    expect(
      threadNotificationText({ kind: "limited", usageLimitResetAt: "not a date" }, options).excerpt,
    ).toBe("Try again later.");
  });
});

describe("assistantTextFromLatestMessage", () => {
  it("only trusts the assistant's own words", () => {
    expect(assistantTextFromLatestMessage({ role: "assistant", text: "hi" })).toBe("hi");
    expect(assistantTextFromLatestMessage({ role: "user", text: "hi" })).toBeNull();
    expect(assistantTextFromLatestMessage(null)).toBeNull();
  });
});

describe("notificationSubtitle", () => {
  it("adds the project only when it tells the reader something", () => {
    expect(notificationSubtitle("Finished", "workbench", "Fix the build")).toBe(
      "Finished · workbench",
    );
    expect(notificationSubtitle("Finished", "  ", "Fix the build")).toBe("Finished");
    expect(notificationSubtitle("Finished", "fix the build", "Fix the build")).toBe("Finished");
    expect(notificationSubtitle("Finished", undefined, "Fix the build")).toBe("Finished");
  });

  it("never ends in a separator", () => {
    expect(notificationSubtitle(" Failed ", "", "x")).toBe("Failed");
    expect(meaningfulProjectTitle("", "x")).toBeNull();
  });
});
