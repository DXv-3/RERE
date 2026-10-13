/**
 * Where a candidate came from, best first. When the same skill is reachable twice (a copy in
 * the user's folder and the one a plugin brings, or a provider's own listing of either), the
 * copy the user wrote or chose wins over one that arrived with a plugin or a download.
 */
export const candidateRank = {
  own: 0,
  reviewed: 1,
  plugin: 2,
  downloaded: 3,
  provider: 4,
} as const;

export interface DuplicateCandidate {
  readonly name: string;
  readonly description: string;
  readonly rank: number;
  /** Hash of the skill's file when it has one; two copies of one file are one skill. */
  readonly sha256?: string;
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Jev is billed per candidate and picks one, so two entries for the same skill only split its
 * vote. A candidate is dropped when an earlier one has the same file or the same description.
 * Named candidates keep their place first, then the best-ranked copy; the input order breaks
 * ties, so the same library always produces the same list.
 */
export function dropDuplicateCandidates<T extends DuplicateCandidate>(
  candidates: readonly T[],
  named: (name: string) => boolean = () => false,
): T[] {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .toSorted(
      (a, b) =>
        Number(named(b.candidate.name)) - Number(named(a.candidate.name)) ||
        a.candidate.rank - b.candidate.rank ||
        a.index - b.index,
    );
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const { candidate } of ordered) {
    const keys = [
      `d:${normalized(candidate.description)}`,
      ...(candidate.sha256 ? [`h:${candidate.sha256}`] : []),
    ];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    kept.push(candidate);
  }
  return kept;
}
