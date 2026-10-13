import { describe, expect, it } from "vite-plus/test";

import { findRepositoryReferences, repositoryReferenceUrl } from "./repositoryReferences.ts";

const numbers = (text: string) => findRepositoryReferences(text).map((found) => found.number);
const spans = (text: string) =>
  findRepositoryReferences(text).map((found) => text.slice(found.start, found.end));

describe("findRepositoryReferences", () => {
  it("finds a mention in prose, with its position", () => {
    const text = "Merged #1170 and #1171 today.";
    expect(findRepositoryReferences(text)).toEqual([
      { start: 7, end: 12, number: 1170, repository: null },
      { start: 17, end: 22, number: 1171, repository: null },
    ]);
  });

  it.each([
    ["**#1155 (keyword map)**", ["#1155"]],
    ["- #12\n- #13", ["#12", "#13"]],
    ["(#1170)", ["#1170"]],
    ["see [#1170]", ["#1170"]],
    ["#1170, #1171; and #1172.", ["#1170", "#1171", "#1172"]],
    ["fixed in #1170: done", ["#1170"]],
    ["#1170's author", ["#1170"]],
    ["pull request #1170-ish", ["#1170"]],
  ] as const)("finds mentions beside punctuation: %s", (text, expected) => {
    expect(spans(text)).toEqual(expected);
  });

  it.each([
    "color: #fff;",
    "background #1e1e1e",
    "#123abc",
    "#12345678",
    "#0",
    "#007",
    "abc#12",
    "path/#12",
    "##12",
    "&#35;12",
    "# 12",
    "#",
    "no number # here",
    "#12_",
  ])("leaves what is not a mention alone: %s", (text) => {
    expect(numbers(text)).toEqual([]);
  });

  it("reads owner/repo#number as a mention of that repository", () => {
    expect(findRepositoryReferences("see acme/web#42 and t3-tools/t3.code#7!")).toEqual([
      { start: 4, end: 15, number: 42, repository: "acme/web" },
      { start: 20, end: 38, number: 7, repository: "t3-tools/t3.code" },
    ]);
  });

  it("does not read a path or a longer slug as an owner/repo mention", () => {
    expect(numbers("see src/a/b#12")).toEqual([]);
    expect(numbers("v1.owner/repo#12")).toEqual([]);
    expect(numbers("x_owner/repo#12")).toEqual([]);
    expect(numbers("/owner/repo#12")).toEqual([]);
  });

  it("returns nothing for text with no # without scanning it", () => {
    expect(findRepositoryReferences("plain text".repeat(1_000))).toEqual([]);
  });

  it("stays linear on long and adversarial messages", () => {
    const mentions = Array.from({ length: 20_000 }, (_, index) => `fix #${index + 1}`).join("\n");
    const adversarial = `${"a".repeat(200_000)}/${"b".repeat(200_000)}#${"1".repeat(200_000)}`;
    const dashes = `${"a-".repeat(100_000)}#12 ${"#".repeat(100_000)}`;
    const started = performance.now();
    expect(findRepositoryReferences(mentions)).toHaveLength(20_000);
    expect(findRepositoryReferences(adversarial)).toEqual([]);
    expect(findRepositoryReferences(dashes)).toHaveLength(1);
    // Generous: the point is "not quadratic", which at this size would take minutes.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("repositoryReferenceUrl", () => {
  it("links a bare mention to the thread's repository, whatever route form it was given", () => {
    const reference = { number: 1170, repository: null };
    expect(repositoryReferenceUrl("https://github.com/acme/web", reference)).toBe(
      "https://github.com/acme/web/issues/1170",
    );
    expect(repositoryReferenceUrl("https://github.com/acme/web/", reference)).toBe(
      "https://github.com/acme/web/issues/1170",
    );
  });

  it("links owner/repo#n to that repository on the same host", () => {
    expect(
      repositoryReferenceUrl("https://github.acme.test/platform/api", {
        number: 3,
        repository: "other/lib",
      }),
    ).toBe("https://github.acme.test/other/lib/issues/3");
  });

  it("refuses a repository URL that is not http(s)", () => {
    expect(
      repositoryReferenceUrl("javascript:alert(1)", { number: 1, repository: null }),
    ).toBeNull();
    expect(repositoryReferenceUrl("not a url", { number: 1, repository: null })).toBeNull();
  });
});
