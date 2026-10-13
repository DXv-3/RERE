import { redactProviderFailureText } from "../orchestration-v2/ProviderFailure.ts";

const MAX_EXCERPT_LENGTH = 240;

/**
 * The first line of a tool's stderr that says something, redacted and cut to a length a toast
 * can hold. `gh` repeats the same complaint once per field it could not read, so one line carries
 * the reason and the rest only repeats it.
 */
export function stderrExcerpt(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/u)) {
    const text = redactProviderFailureText(line).replace(/\s+/gu, " ").trim();
    // Lines gh prints around an error (a hint, a deprecation warning) are not the error.
    if (text.length === 0 || /^(?:warning|hint|note)\b/iu.test(text)) continue;
    if (text.length <= MAX_EXCERPT_LENGTH) return text;
    // Never cut a surrogate pair in half.
    const end = /[\ud800-\udbff]/u.test(text.charAt(MAX_EXCERPT_LENGTH - 1))
      ? MAX_EXCERPT_LENGTH - 1
      : MAX_EXCERPT_LENGTH;
    return `${text.slice(0, end)}…`;
  }
  return undefined;
}
