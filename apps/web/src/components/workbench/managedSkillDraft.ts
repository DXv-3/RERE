import {
  countManagedSkillBlocks,
  managedSkillBlock,
  managedSkillMarker,
  type ManagedSkillLoad,
} from "@t3tools/contracts";

export function appendManagedSkillStage(draft: string, skill: ManagedSkillLoad) {
  if (draft.includes(managedSkillMarker(skill)))
    return { status: "already_present" as const, draft };
  if (countManagedSkillBlocks(draft) >= 2) return { status: "limit" as const, draft };
  const block = managedSkillBlock(skill);
  return {
    status: "added" as const,
    draft: draft.trimEnd() ? `${draft.trimEnd()}\n\n${block}` : block,
  };
}
