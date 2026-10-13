import {
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { upsertProviderTurn } from "./ProjectionStore.ts";

describe("provider turn token usage projection", () => {
  it("keeps live usage when a terminal update omits it", () => {
    const now = DateTime.makeUnsafe("2026-08-29T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-usage"),
      providerThreadId: ProviderThreadId.make("provider-thread-usage"),
      nodeId: NodeId.make("node-usage"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      tokenUsage: {
        usedTokens: 50_000,
        maxTokens: 200_000,
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    } satisfies OrchestrationV2ProviderTurn;
    const completed = {
      ...running,
      status: "completed",
      completedAt: now,
      tokenUsage: undefined,
    } satisfies OrchestrationV2ProviderTurn;

    const projected = upsertProviderTurn([running], completed);

    assert.deepEqual(projected[0]?.tokenUsage, running.tokenUsage);
    assert.equal(projected[0]?.status, "completed");
  });

  it("keeps the answering model when a later update omits it, and takes a newer one", () => {
    const now = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");
    const running = {
      id: ProviderTurnId.make("provider-turn-model"),
      providerThreadId: ProviderThreadId.make("provider-thread-model"),
      nodeId: NodeId.make("node-model"),
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      answeringModel: "qwen3.6:35b-a3b",
    } satisfies OrchestrationV2ProviderTurn;
    const { answeringModel: _omitted, ...withoutModel } = running;
    const completed = {
      ...withoutModel,
      status: "completed",
      completedAt: now,
    } satisfies OrchestrationV2ProviderTurn;

    const kept = upsertProviderTurn([running], completed);
    assert.equal(kept[0]?.answeringModel, "qwen3.6:35b-a3b");
    assert.equal(kept[0]?.status, "completed");

    const switched = upsertProviderTurn(kept, { ...completed, answeringModel: "qwen3.8:27b" });
    assert.equal(switched[0]?.answeringModel, "qwen3.8:27b");
  });
});
