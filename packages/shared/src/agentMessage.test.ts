import { describe, expect, it } from "vite-plus/test";

import { splitAgentMessage, splitSkillBlocks } from "./agentMessage.ts";

const revision = "a".repeat(64);
const block = (id: string, name: string) =>
  `[Workbench skill ${id}@${revision} stage:implement]\nRequested permissions: none.\nUse the "${name}" skill for this task. Read ~/x/SKILL.md in full.\n[End Workbench skill]`;

describe("splitSkillBlocks", () => {
  it("lifts every attached skill block out and names the skills", () => {
    const text = `Fix the login test\n\n${block("go", "go")}\n\n${block("plugin-gcloud-tools-setup", "gcloud-tools:setup")}`;
    const { request, skills } = splitSkillBlocks(text);
    expect(request).toBe("Fix the login test");
    expect(skills.map((skill) => skill.name)).toEqual(["go", "gcloud-tools:setup"]);
    expect(skills[0]?.raw).toBe(block("go", "go"));
  });

  it("falls back to the id when a block names no skill, and leaves other text alone", () => {
    const bare = `[Workbench skill billing-review@${revision} stage:review]\nCheck twice.\n[End Workbench skill]`;
    expect(splitSkillBlocks(bare).skills[0]?.name).toBe("billing-review");
    const plain = "A message with [brackets] and no skill.";
    expect(splitSkillBlocks(plain)).toEqual({ request: plain, skills: [] });
  });
});

describe("splitAgentMessage", () => {
  it("still splits agent instructions from the request", () => {
    expect(splitAgentMessage("<workbench-agent>\nBe brief\n</workbench-agent>\nHi")).toEqual({
      instructions: "Be brief",
      request: "Hi",
    });
  });
});
