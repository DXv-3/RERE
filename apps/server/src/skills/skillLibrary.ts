import * as NodeCrypto from "node:crypto";
import type { ManagedSkillManifest } from "@t3tools/contracts";

/** Marks a catalog entry that points at a file in the user's own skill library. */
const LIBRARY_SOURCE_PREFIX = "local-library:";
/** Marks a catalog entry that points at a skill inside an installed Claude plugin. */
const PLUGIN_SOURCE_PREFIX = "plugin-library:";

/** True for entries that point at a file instead of carrying their own text. */
export const isLibrarySource = (source: string) =>
  source.startsWith(LIBRARY_SOURCE_PREFIX) || source.startsWith(PLUGIN_SOURCE_PREFIX);

/** Catalog id for a plugin's skill, inside the id pattern; long names keep a hash so they stay unique. */
export function pluginSkillId(plugin: string, skill: string): string {
  const id = `plugin-${plugin}-${skill}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-");
  if (id.length <= 80) return id.replace(/-$/, "");
  const tail = NodeCrypto.createHash("sha256")
    .update(`${plugin}/${skill}`)
    .digest("hex")
    .slice(0, 8);
  return `${id.slice(0, 71).replace(/-$/, "")}-${tail}`;
}

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/**
 * Reads `name` and `description` from a SKILL.md front matter block. Handles
 * the plain, quoted, folded (`>`) and literal (`|`) forms those files use.
 */
export function readSkillFrontMatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return {};
  const lines = block.split(/\r?\n/);
  const read = (key: string) => {
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start === -1) return undefined;
    const first = lines[start]!.slice(key.length + 1).trim();
    const parts = /^[>|][+-]?$/.test(first) ? [] : [first];
    // Indented lines continue the value; the next top-level key ends it.
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      parts.push(line.trim());
    }
    const value = parts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    return value || undefined;
  };
  const name = read("name");
  const description = read("description");
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/**
 * A catalog entry for one library skill. The entry carries a pointer, not the
 * skill's text: the agent reads the file only when the skill is chosen, so a
 * long skill costs nothing until it is used. Returns null for a folder that
 * cannot be a catalog id or a file with no description to select by.
 */
export function libraryManifest(input: {
  folder: string;
  /** Home-relative (`~/…`) or absolute path of the SKILL.md. */
  path: string;
  text: string;
  sha256: string;
  /** An installed plugin's skill: id, name and source come from the plugin, not the folder. */
  plugin?: string;
}): ManagedSkillManifest | null {
  const id = input.plugin
    ? pluginSkillId(input.plugin, input.folder)
    : input.folder.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return null;
  const front = readSkillFrontMatter(input.text);
  if (!front.description) return null;
  const name = clip(
    input.plugin ? `${input.plugin}:${input.folder}` : (front.name ?? input.folder),
    120,
  );
  return {
    id,
    name,
    description: clip(front.description, 280),
    source: input.plugin
      ? `${PLUGIN_SOURCE_PREFIX}${input.plugin}/${input.folder}/SKILL.md`
      : `${LIBRARY_SOURCE_PREFIX}${input.folder}/SKILL.md`,
    sourceRevision: "library-sync",
    sourceSha256: input.sha256,
    reviewNote: input.plugin
      ? "Provided by an installed Claude plugin. It can ask for anything its own instructions say."
      : "Imported from the local skill library without review. It can ask for anything its own instructions say; enable only skills you trust.",
    permissions: ["Whatever this skill's own instructions call for"],
    projectRoots: [],
    dependencies: [{ path: input.path, executable: false }],
    stages: [
      {
        stage: "implement",
        instructions: `Use the "${name}" skill for this task. Read ${input.path} in full before starting and follow it.`,
      },
    ],
  };
}
