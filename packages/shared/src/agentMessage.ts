export function splitAgentMessage(text: string): { instructions: string | null; request: string } {
  const match = /^<workbench-agent>\n([\s\S]*?)\n<\/workbench-agent>\s*/.exec(text);
  return match
    ? { instructions: match[1]!, request: text.slice(match[0].length) }
    : { instructions: null, request: text };
}

export interface SkillBlock {
  readonly id: string;
  /** The skill's name as the block's own instructions give it, else its id. */
  readonly name: string;
  readonly raw: string;
}

const SKILL_BLOCK =
  /\[Workbench skill ([a-z0-9-]+)@[a-f0-9]{64} stage:[a-z-]+\][\s\S]*?\[End Workbench skill\]/g;

/**
 * Pulls the `[Workbench skill …]…[End Workbench skill]` blocks Auto (or a person) attached out
 * of a message, so a timeline can show "Skills: name, name" instead of pages of instructions.
 * `request` is what is left, without the blank lines the blocks sat between.
 */
export function splitSkillBlocks(text: string): { request: string; skills: SkillBlock[] } {
  const skills: SkillBlock[] = [];
  const request = text.replace(SKILL_BLOCK, (raw, id: string) => {
    const name = /Use the "([^"\n]+)" skill for this task/.exec(raw)?.[1];
    skills.push({ id, name: name ?? id, raw });
    return "";
  });
  return skills.length === 0 ? { request: text, skills } : { request: request.trim(), skills };
}
