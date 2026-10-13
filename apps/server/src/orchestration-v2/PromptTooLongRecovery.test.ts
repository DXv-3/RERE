import { assert, describe, it } from "@effect/vitest";
import {
  parsePromptTooLongRecoveryMessageId,
  promptTooLongRecoveryMessageId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";

import { nextPromptTooLongRecoveryStep } from "./PromptTooLongRecovery.ts";

type RunInput = Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
const run = (status: OrchestrationV2Run["status"], userMessageId: string): RunInput =>
  ({ id: "run:2", status, userMessageId }) as RunInput;
const decide = (
  input: Partial<Parameters<typeof nextPromptTooLongRecoveryStep>[0]> & { run: RunInput },
) =>
  nextPromptTooLongRecoveryStep({
    failureCode: null,
    hasLaterRun: false,
    existingMessageIds: new Set(),
    ...input,
  });

describe("nextPromptTooLongRecoveryStep", () => {
  it("compacts after the user's own run fails with prompt_too_long", () => {
    assert.deepStrictEqual(
      decide({ run: run("failed", "message:1"), failureCode: "prompt_too_long" }),
      { step: "compact", rootRunId: "run:2" },
    );
  });

  it("leaves every other failure and outcome alone", () => {
    for (const status of ["completed", "interrupted", "cancelled"] as const) {
      assert.isNull(decide({ run: run(status, "message:1"), failureCode: "prompt_too_long" }));
    }
    assert.isNull(decide({ run: run("failed", "message:1"), failureCode: "usage_limit" }));
    assert.isNull(decide({ run: run("failed", "message:1") }));
  });

  it("retries once the compaction completes, and goes fresh when it fails", () => {
    const compact = promptTooLongRecoveryMessageId("compact", "run:1");
    assert.deepStrictEqual(decide({ run: run("completed", compact) }), {
      step: "retry",
      rootRunId: "run:1",
    });
    assert.deepStrictEqual(decide({ run: run("failed", compact), failureCode: "other" }), {
      step: "fresh",
      rootRunId: "run:1",
    });
    assert.isNull(decide({ run: run("interrupted", compact) }));
  });

  it("goes fresh when the retry is still too long, and stops after the fresh session", () => {
    const retry = promptTooLongRecoveryMessageId("retry", "run:1");
    assert.deepStrictEqual(decide({ run: run("failed", retry), failureCode: "prompt_too_long" }), {
      step: "fresh",
      rootRunId: "run:1",
    });
    assert.isNull(decide({ run: run("failed", retry), failureCode: "usage_limit" }));
    assert.isNull(decide({ run: run("completed", retry) }));
    const fresh = promptTooLongRecoveryMessageId("fresh", "run:1");
    assert.isNull(decide({ run: run("failed", fresh), failureCode: "prompt_too_long" }));
  });

  it("never repeats a step whose message exists, and yields to a newer run", () => {
    const compact = promptTooLongRecoveryMessageId("compact", "run:2");
    assert.isNull(
      decide({
        run: run("failed", "message:1"),
        failureCode: "prompt_too_long",
        existingMessageIds: new Set([compact]),
      }),
    );
    assert.isNull(
      decide({
        run: run("failed", "message:1"),
        failureCode: "prompt_too_long",
        hasLaterRun: true,
      }),
    );
  });
});

describe("prompt too long recovery message ids", () => {
  it("round-trips the step and root run", () => {
    assert.deepStrictEqual(
      parsePromptTooLongRecoveryMessageId(promptTooLongRecoveryMessageId("fresh", "run:a:b")),
      { step: "fresh", rootRunId: "run:a:b" },
    );
    assert.isNull(parsePromptTooLongRecoveryMessageId("message:restart-continuation:run:1"));
    assert.isNull(parsePromptTooLongRecoveryMessageId("message:prompt-too-long-recovery:oops:x"));
  });
});
