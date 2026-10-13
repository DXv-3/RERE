/** Explicit references outrank inferred matches, but never bypass scope or enablement. */
export function explicitSkillNames(task: string): ReadonlySet<string> {
  return new Set(
    [...task.matchAll(/(?:^|[\s(])\$([a-z0-9][a-z0-9:_-]*)(?=$|[\s,.;!?)])/gi)].map((match) =>
      match[1]!.toLowerCase(),
    ),
  );
}

/**
 * A message that opens with `/name` and nothing else before it. Real slash commands look the
 * same, so the caller decides whether `name` is a skill; this only reads the shape.
 */
export function leadingSlashName(text: string): string | null {
  const match = /^\s*\/([a-z0-9][a-z0-9:_-]*)(?=$|\s)/i.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}
