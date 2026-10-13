/**
 * A `#123` or `owner/repo#123` written in prose, found in plain text. The caller owns the markup:
 * this only says where a mention starts and ends and what it names, so anything that is not prose
 * (code, an existing link) is kept out by running it over text the parser already separated.
 */
export interface RepositoryReference {
  /** Index of the first character of the mention, and one past its last. */
  readonly start: number;
  readonly end: number;
  readonly number: number;
  /** `owner/repo` when the mention names another repository, otherwise null. */
  readonly repository: string | null;
}

/**
 * Digits only, no leading zero, and not followed by anything a word is made of: `#fff` is no
 * number, `#1e1e1e` and `#123abc` are not either, and seven digits is as large as a repository
 * number gets. The optional prefix is GitHub's `owner/repo` (owner: letters, digits, hyphens).
 *
 * Every quantifier is bounded and nothing nests, so a match costs a constant amount of work
 * and a scan is linear in the text.
 */
const REFERENCE_PATTERN =
  /(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}))?#([1-9][0-9]{0,6})(?![A-Za-z0-9_])/g;

/** What may not come right before a bare `#123`: `abc#1`, `a/#1`, `##1`, `&#1;`. */
const BLOCKS_BARE_REFERENCE = /[A-Za-z0-9_/#&]/;
/** What may not come right before an `owner/repo#1`: the same, and a dotted or hyphenated name. */
const BLOCKS_PREFIXED_REFERENCE = /[A-Za-z0-9_/#&.-]/;

const NONE: ReadonlyArray<RepositoryReference> = [];

/**
 * Every mention in `text`, in order. Text without a `#` — most of it — returns without running
 * the pattern at all.
 */
export function findRepositoryReferences(text: string): ReadonlyArray<RepositoryReference> {
  if (!text.includes("#")) return NONE;
  const found: Array<RepositoryReference> = [];
  // The pattern is global, so `exec` carries its position; it ends at null, which resets it.
  REFERENCE_PATTERN.lastIndex = 0;
  for (
    let match = REFERENCE_PATTERN.exec(text);
    match !== null;
    match = REFERENCE_PATTERN.exec(text)
  ) {
    const repository = match[1] === undefined ? null : `${match[1]}/${match[2]}`;
    const before = text.charAt(match.index - 1);
    if (
      before !== "" &&
      (repository === null ? BLOCKS_BARE_REFERENCE : BLOCKS_PREFIXED_REFERENCE).test(before)
    ) {
      continue;
    }
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      number: Number(match[3]),
      repository,
    });
  }
  return found.length === 0 ? NONE : found;
}

/**
 * Where a mention points: the issue route of the repository it names, on the host `repositoryUrl`
 * lives on. GitHub sends `/issues/N` to the pull request when N is one (and `/pull/N` to the
 * issue when it is not), so the route does not have to know which it is.
 */
export function repositoryReferenceUrl(
  repositoryUrl: string,
  reference: Pick<RepositoryReference, "number" | "repository">,
): string | null {
  try {
    const base = new URL(repositoryUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    const path =
      reference.repository === null
        ? base.pathname.replace(/\/+$/u, "")
        : `/${reference.repository}`;
    return `${base.origin}${path}/issues/${reference.number}`;
  } catch {
    return null;
  }
}
