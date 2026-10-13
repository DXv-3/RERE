import {
  parsePromptTooLongRecoveryMessageId,
  isUnsupportedHistoryRecoveryMessageId,
  promptTooLongRecoveryMessageId,
  type OrchestrationV2Run,
  type PromptTooLongRecoveryStep,
} from "@t3tools/contracts";

import { PROMPT_TOO_LONG_CODE } from "./Adapters/claudePromptTooLong.ts";

/**
 * What the server does when a run ends because the conversation no longer fits the model. Each
 * step is a message whose id names the step and the original failed run, so the whole chain is
 * recoverable from the stored messages: the next step is decided from the run that just ended, and
 * a step whose message already exists is never sent again, even across a restart.
 *
 * original run fails  -> compact (native `/compact`)
 * compact completes   -> retry   (continue the request on the shortened session)
 * compact fails       -> fresh   (continue on a new native session with a summary)
 * retry fails too     -> fresh
 * fresh fails         -> nothing; the failure stays as the provider reported it
 */
export function nextPromptTooLongRecoveryStep(input: {
  readonly run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
  /** The `code` of the run's failure, when it failed. */
  readonly failureCode: string | null | undefined;
  /** Another run (other than a queued one) started after this one: the user moved on. */
  readonly hasLaterRun: boolean;
  readonly existingMessageIds: ReadonlySet<string>;
}): { readonly step: PromptTooLongRecoveryStep; readonly rootRunId: string } | null {
  if (input.hasLaterRun || isUnsupportedHistoryRecoveryMessageId(input.run.userMessageId))
    return null;
  const { run } = input;
  const own = parsePromptTooLongRecoveryMessageId(run.userMessageId);
  const next = (step: PromptTooLongRecoveryStep, rootRunId: string) =>
    input.existingMessageIds.has(promptTooLongRecoveryMessageId(step, rootRunId))
      ? null
      : { step, rootRunId };
  const tooLong = run.status === "failed" && input.failureCode === PROMPT_TOO_LONG_CODE;
  if (own === null) return tooLong ? next("compact", run.id) : null;
  switch (own.step) {
    case "compact":
      // An interrupted compaction is the user stopping the recovery.
      if (run.status === "completed") return next("retry", own.rootRunId);
      return run.status === "failed" ? next("fresh", own.rootRunId) : null;
    case "retry":
      return tooLong ? next("fresh", own.rootRunId) : null;
    case "fresh":
      return null;
  }
}

/** The prompt of a retry or fresh-session run: the same request, not a replay of its tool calls. */
export const PROMPT_TOO_LONG_CONTINUATION_TEXT =
  "Your previous turn stopped because the conversation grew too long for the model, so it was " +
  "shortened. Continue the request you were working on where you left off. Check what is " +
  "already done before acting, and do not repeat steps that already ran.";
