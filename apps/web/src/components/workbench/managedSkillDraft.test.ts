import { expect, it } from "vite-plus/test";
import type { ManagedSkillLoad } from "@t3tools/contracts";
import { appendManagedSkillStage } from "./managedSkillDraft";
const skill: ManagedSkillLoad = {
  id: "review",
  revision: "a".repeat(64),
  stage: "review",
  instructions: "Review supplied frames.",
  utf8Bytes: 23,
  tokenCount: null,
  permissions: ["read media"],
};
it("preserves a draft and adds only the chosen stage with explicit permission bounds", () => {
  const result = appendManagedSkillStage("My original goal", skill);
  expect(result.status).toBe("added");
  expect(result.draft).toContain("My original goal");
  expect(result.draft).toContain(skill.instructions);
  expect(result.draft).toContain("grants no additional permissions");
  expect(appendManagedSkillStage(result.draft, skill)).toEqual({
    status: "already_present",
    draft: result.draft,
  });
});
it("bounds a draft to two distinct skill stages and allows replacement after removal", () => {
  const first = appendManagedSkillStage("Task", skill);
  const second = appendManagedSkillStage(first.draft, { ...skill, stage: "plan" });
  expect(second.status).toBe("added");
  expect(appendManagedSkillStage(second.draft, { ...skill, stage: "verify" }).status).toBe("limit");
  expect(appendManagedSkillStage("Task", { ...skill, stage: "verify" }).status).toBe("added");
});
