import { expect, it } from "vite-plus/test";

import {
  SKILL_PACKS,
  findPack,
  isInside,
  isSafeName,
  isSafeRelativePath,
  packProblem,
  repositorySlug,
  summarizePack,
} from "./skillPacks.ts";

it("ships only well-formed packs pinned to full commits on github.com", () => {
  expect(SKILL_PACKS.length).toBeGreaterThan(0);
  for (const pack of SKILL_PACKS) expect(packProblem(pack)).toBeNull();
  const sources = SKILL_PACKS.flatMap((pack) => pack.sources);
  // The same source id in two packs must be the same repository and commit.
  for (const source of sources)
    expect(sources.filter((other) => other.id === source.id).map((other) => other.commit)).toEqual(
      sources.filter((other) => other.id === source.id).map(() => source.commit),
    );
  // Owner-private skills and repositories without a license file are never offered.
  const urls = sources.map((source) => source.repositoryUrl).join(" ");
  expect(urls).not.toContain("fal-ai-community");
  expect(sources.every((source) => source.licenseFile.length > 0)).toBe(true);
});

it("rejects a definition that is not a pinned github.com repository or climbs out of it", () => {
  const pack = SKILL_PACKS[0]!;
  const source = pack.sources[0]!;
  const bad = (change: Partial<typeof source>) =>
    packProblem({ ...pack, sources: [{ ...source, ...change }] });
  expect(bad({ repositoryUrl: "https://gitlab.com/a/b" })).not.toBeNull();
  expect(bad({ repositoryUrl: "http://github.com/a/b" })).not.toBeNull();
  expect(bad({ repositoryUrl: "https://github.com/a/b/../../c" })).not.toBeNull();
  expect(bad({ commit: "main" })).not.toBeNull();
  expect(bad({ commit: "aed9cfd" })).not.toBeNull();
  expect(bad({ skillsPath: "../outside" })).not.toBeNull();
  expect(bad({ skillsPath: "/etc" })).not.toBeNull();
  expect(bad({ include: ["../evil"] })).not.toBeNull();
  expect(bad({ licenseFile: "../LICENSE" })).not.toBeNull();
});

it("judges names and paths", () => {
  expect(repositorySlug("https://github.com/greensock/gsap-skills")).toBe("greensock/gsap-skills");
  expect(repositorySlug("https://github.com/greensock")).toBeNull();
  expect(repositorySlug("https://example.com/a/b")).toBeNull();
  expect(isSafeName("gsap-core")).toBe(true);
  expect(isSafeName("..")).toBe(false);
  expect(isSafeName("a/b")).toBe(false);
  expect(isSafeName(".hidden")).toBe(false);
  expect(isSafeRelativePath(".claude/skills")).toBe(true);
  expect(isSafeRelativePath("skills")).toBe(true);
  expect(isSafeRelativePath("a/../b")).toBe(false);
  expect(isSafeRelativePath("..")).toBe(false);
  expect(isSafeRelativePath("a\\b")).toBe(false);
  expect(isInside("/lib", "/lib/gsap/x")).toBe(true);
  expect(isInside("/lib", "/lib")).toBe(true);
  expect(isInside("/lib", "/library/x")).toBe(false);
  expect(isInside("/lib", "/other")).toBe(false);
});

it("summarizes a pack by what is installed", () => {
  const pack = findPack("video-and-motion")!;
  const listed = summarizePack(pack, undefined);
  expect(listed).toMatchObject({ installed: false, updateAvailable: false, skillCount: 39 });
  const current = Object.fromEntries(
    pack.sources.map((source) => [source.id, { commit: source.commit, skills: ["a", "b"] }]),
  );
  expect(summarizePack(pack, current)).toMatchObject({
    installed: true,
    updateAvailable: false,
    skillCount: 6,
  });
  const stale = { ...current, gsap: { commit: "0".repeat(40), skills: ["a"] } };
  expect(summarizePack(pack, stale)).toMatchObject({ installed: true, updateAvailable: true });
  const partial = { gsap: current.gsap! };
  expect(summarizePack(pack, partial).installed).toBe(false);
  expect(summarizePack(pack, partial).sources.map((s) => s.installedCommit)).toEqual([
    pack.sources[0]!.commit,
    null,
    null,
  ]);
});
