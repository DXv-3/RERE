import { expect, it } from "vite-plus/test";

import { libraryManifest, pluginSkillId, readSkillFrontMatter } from "./skillLibrary.ts";

it("reads plain, quoted and folded descriptions and stops at the next key", () => {
  expect(readSkillFrontMatter("---\nname: qa\ndescription: Test the app.\n---\nbody")).toEqual({
    name: "qa",
    description: "Test the app.",
  });
  expect(
    readSkillFrontMatter(
      '---\nname: "Reel Watch"\ndescription: >\n  Review reels\n  and captions.\nlicense: MIT\n---',
    ),
  ).toEqual({ name: "Reel Watch", description: "Review reels and captions." });
  expect(
    readSkillFrontMatter(
      "---\ndescription: First line\n  continues here.\nallowed-tools: Bash\n---",
    ),
  ).toEqual({ description: "First line continues here." });
  expect(readSkillFrontMatter("no front matter")).toEqual({});
});

it("builds a pointer entry that carries the file's hash, not its text", () => {
  const manifest = libraryManifest({
    folder: "Reel_Watch",
    path: "~/.claude/skills/Reel_Watch/SKILL.md",
    text: `---\nname: reel-watch\ndescription: ${"Review reels. ".repeat(40)}\n---\n${"x".repeat(20_000)}`,
    sha256: "a".repeat(64),
  });
  expect(manifest).toMatchObject({
    id: "reel-watch",
    name: "reel-watch",
    source: "local-library:Reel_Watch/SKILL.md",
    sourceSha256: "a".repeat(64),
    dependencies: [{ path: "~/.claude/skills/Reel_Watch/SKILL.md", executable: false }],
  });
  expect(manifest!.description.length).toBeLessThanOrEqual(280);
  expect(manifest!.stages[0]!.instructions).toBe(
    'Use the "reel-watch" skill for this task. Read ~/.claude/skills/Reel_Watch/SKILL.md in full before starting and follow it.',
  );
});

it("skips a skill with no description or an unusable folder name", () => {
  const base = { path: "~/x/SKILL.md", sha256: "b".repeat(64) };
  expect(libraryManifest({ ...base, folder: "ok", text: "---\nname: ok\n---" })).toBeNull();
  expect(
    libraryManifest({ ...base, folder: "-bad", text: "---\ndescription: Something.\n---" }),
  ).toBeNull();
});

it("names plugin skills plugin:skill and keeps long ids inside the pattern and unique", () => {
  const text = "---\ndescription: Does a thing.\n---\nBody";
  expect(
    libraryManifest({
      folder: "setup",
      path: "/p/SKILL.md",
      text,
      sha256: "a".repeat(64),
      plugin: "gcloud-tools",
    }),
  ).toMatchObject({
    id: "plugin-gcloud-tools-setup",
    name: "gcloud-tools:setup",
    source: "plugin-library:gcloud-tools/setup/SKILL.md",
  });
  const long = (skill: string) => pluginSkillId("p".repeat(60), skill.repeat(20));
  expect(long("a")).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);
  expect(long("a")).not.toBe(long("b"));
});
