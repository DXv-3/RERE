/**
 * Claude's "the conversation no longer fits the model" result.
 *
 * Newer CLIs name it in `terminal_reason`; older ones only say it in the result text. It is not a
 * usage limit: waiting for an allowance to reset never fixes it, shortening the conversation does.
 */
export const PROMPT_TOO_LONG_CODE = "prompt_too_long";

export const PROMPT_TOO_LONG_MESSAGE =
  "This conversation no longer fits the model's context. Send /compact to shorten it, or continue in a new thread.";

const PROMPT_TOO_LONG_TEXT = /\bprompt is too long\b/i;

export function isPromptTooLongResult(result: {
  readonly terminal_reason?: string | null | undefined;
  readonly result?: unknown;
  readonly errors?: unknown;
}): boolean {
  if (result.terminal_reason === PROMPT_TOO_LONG_CODE) return true;
  if (typeof result.result === "string" && PROMPT_TOO_LONG_TEXT.test(result.result)) return true;
  return (
    Array.isArray(result.errors) &&
    result.errors.some((error) => typeof error === "string" && PROMPT_TOO_LONG_TEXT.test(error))
  );
}
