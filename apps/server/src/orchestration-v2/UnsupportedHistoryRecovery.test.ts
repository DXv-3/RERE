import { assert, it } from "@effect/vitest";
import { RunId, MessageId } from "@t3tools/contracts";
import { unsupportedHistoryRecovery } from "./UnsupportedHistoryRecovery.ts";
import { nextPromptTooLongRecoveryStep } from "./PromptTooLongRecovery.ts";

const input = {
  run: {
    id: RunId.make("run:1"),
    status: "failed" as const,
    userMessageId: MessageId.make("message:1"),
  },
  failureCode: "codex_unsupported_history",
  hasLaterRun: false,
  existingMessageIds: new Set<string>(),
};
it("makes one durable fresh-session attempt for rejected history", () => {
  const recovery = unsupportedHistoryRecovery(input)!;
  assert.equal(recovery.messageId, "message:unsupported-history-recovery:run:1");
  assert.include(recovery.text, "same model");
  assert.isNull(
    unsupportedHistoryRecovery({ ...input, existingMessageIds: new Set([recovery.messageId]) }),
  );
});
it("leaves unrelated errors, newer work and stopped runs alone", () => {
  for (const failureCode of [
    null,
    "subscription_sharing_unsupported_capability",
    "usageLimitExceeded",
  ])
    assert.isNull(unsupportedHistoryRecovery({ ...input, failureCode }));
  assert.isNull(unsupportedHistoryRecovery({ ...input, hasLaterRun: true }));
  for (const status of ["completed", "interrupted", "cancelled"] as const)
    assert.isNull(unsupportedHistoryRecovery({ ...input, run: { ...input.run, status } }));
});
it("does not create cycles between history and context-length recovery", () => {
  for (const userMessageId of [
    "message:unsupported-history-recovery:run:0",
    "message:prompt-too-long-recovery:fresh:run:0",
    "message:prompt-too-long-recovery:retry:run:0",
    "message:prompt-too-long-recovery:compact:run:0",
  ])
    assert.isNull(
      unsupportedHistoryRecovery({
        ...input,
        run: { ...input.run, userMessageId: MessageId.make(userMessageId) },
      }),
    );
  assert.isNull(
    nextPromptTooLongRecoveryStep({
      ...input,
      failureCode: "prompt_too_long",
      run: {
        ...input.run,
        userMessageId: MessageId.make("message:unsupported-history-recovery:run:0"),
      },
    }),
  );
});
