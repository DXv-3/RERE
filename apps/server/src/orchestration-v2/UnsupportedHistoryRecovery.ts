import {
  isUnsupportedHistoryRecoveryMessageId,
  parsePromptTooLongRecoveryMessageId,
  unsupportedHistoryRecoveryMessageId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

/** One fresh session, never an automatic chain of new sessions or compaction attempts. */
export function unsupportedHistoryRecovery(input: {
  readonly run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
  readonly failureCode: string | null | undefined;
  readonly hasLaterRun: boolean;
  readonly existingMessageIds: ReadonlySet<string>;
}): { readonly messageId: string; readonly text: string } | null {
  const { run } = input;
  const messageId = unsupportedHistoryRecoveryMessageId(run.id);
  if (
    run.status !== "failed" ||
    input.failureCode !== "codex_unsupported_history" ||
    input.hasLaterRun ||
    isUnsupportedHistoryRecoveryMessageId(run.userMessageId) ||
    parsePromptTooLongRecoveryMessageId(run.userMessageId) !== null ||
    input.existingMessageIds.has(messageId)
  )
    return null;
  return {
    messageId,
    text:
      "The provider rejected an unsupported item in the previous native session's history. " +
      "Continue the request in this fresh session using the conversation summary and the same model. " +
      "Check what is already done before acting; do not repeat completed actions or uncertain submissions. " +
      "Use CodeWrench's delegate_task for subagents instead of native collaboration tools.",
  };
}
