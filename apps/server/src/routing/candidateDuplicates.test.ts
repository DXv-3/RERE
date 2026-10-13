import { describe, expect, it } from "vite-plus/test";
import { candidateRank, dropDuplicateCandidates } from "./candidateDuplicates.ts";

const skill = (
  name: string,
  description: string,
  rank: number,
  sha256?: string,
): Parameters<typeof dropDuplicateCandidates>[0][number] => ({
  name,
  description,
  rank,
  ...(sha256 ? { sha256 } : {}),
});

describe("dropDuplicateCandidates", () => {
  it("keeps the user's own copy over the plugin's and the provider's listing of the same skill", () => {
    const kept = dropDuplicateCandidates([
      skill("managed:plugin-superpowers-debugging", "Find the root cause.", candidateRank.plugin),
      skill("debugging", "  Find the root   cause.", candidateRank.provider),
      skill("managed:debugging", "Find the root cause.", candidateRank.own),
    ]);
    expect(kept.map((item) => item.name)).toEqual(["managed:debugging"]);
  });

  it("treats two copies of one file as one skill even when the descriptions differ", () => {
    const kept = dropDuplicateCandidates([
      skill("managed:a", "First wording.", candidateRank.own, "f".repeat(64)),
      skill("managed:b", "Second wording.", candidateRank.downloaded, "f".repeat(64)),
      skill("managed:c", "Another skill.", candidateRank.downloaded, "e".repeat(64)),
    ]);
    expect(kept.map((item) => item.name)).toEqual(["managed:a", "managed:c"]);
  });

  it("keeps skills that merely share a name or a first sentence", () => {
    const kept = dropDuplicateCandidates([
      skill("managed:review", "Review a pull request.", candidateRank.own),
      skill("managed:plugin-x-review", "Review a design document.", candidateRank.plugin),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("puts a named skill's copy first, and gives the same list for the same library", () => {
    const input = [
      skill("managed:own-copy", "Same job.", candidateRank.own),
      skill("managed:plugin-copy", "Same job.", candidateRank.plugin),
    ];
    expect(
      dropDuplicateCandidates(input, (name) => name === "managed:plugin-copy").map((i) => i.name),
    ).toEqual(["managed:plugin-copy"]);
    expect(dropDuplicateCandidates(input)).toEqual(dropDuplicateCandidates([...input]));
  });
});
