import { RoutingDecision, type RoutingScorecard } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class RoutingDecisionStoreError extends Schema.TaggedError<RoutingDecisionStoreError>()(
  "RoutingDecisionStoreError",
  {},
) {}

/** One standing pick and what its thread ran afterwards, split the way prices are. */
export interface MovedThread {
  readonly decidedAt: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

const MAX_DECISIONS = 500;
const RECENT = 10;
const encode = Schema.encodeEffect(Schema.fromJsonString(RoutingDecision));
const decode = Schema.decodeEffect(Schema.fromJsonString(RoutingDecision));
const storage = () => new RoutingDecisionStoreError();

export class RoutingDecisionStore extends Context.Service<
  RoutingDecisionStore,
  {
    /** Idempotent per command, so a replayed dispatch does not count twice. */
    readonly record: (decision: RoutingDecision) => Effect.Effect<void, RoutingDecisionStoreError>;
    readonly lastForThread: (
      threadId: string,
    ) => Effect.Effect<RoutingDecision | null, RoutingDecisionStoreError>;
    readonly forThread: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<RoutingDecision>, RoutingDecisionStoreError>;
    readonly markOverridden: (commandId: string) => Effect.Effect<void, RoutingDecisionStoreError>;
    readonly scorecard: Effect.Effect<RoutingScorecard, RoutingDecisionStoreError>;
    /**
     * Every applied pick that moved a thread to another model and still stands, with the tokens
     * the thread then ran on that model, and what Jev has been paid in all.
     */
    readonly movedThreads: Effect.Effect<
      { readonly moves: ReadonlyArray<MovedThread>; readonly jevMicroUsd: number },
      RoutingDecisionStoreError
    >;
  }
>()("t3/routing/RoutingDecisionStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (row: { decision_json: string; overridden: number }) =>
    decode(row.decision_json).pipe(
      Effect.map((decision) => ({ ...decision, overridden: row.overridden === 1 })),
      Effect.mapError(storage),
    );
  const record = Effect.fn("RoutingDecisionStore.record")(function* (decision: RoutingDecision) {
    const body = yield* encode(decision).pipe(Effect.mapError(storage));
    const changed =
      decision.fromInstanceId !== decision.toInstanceId ||
      decision.fromModel !== decision.toModel ||
      decision.fromEffort !== decision.toEffort;
    yield* sql`INSERT OR IGNORE INTO workbench_routing_decisions(command_id,thread_id,decided_at,changed,decision_json)
      VALUES (${decision.commandId},${decision.threadId},${decision.decidedAt},${changed ? 1 : 0},${body})`.pipe(
      Effect.mapError(storage),
    );
    // Picks that changed something are kept for good: they are few, and the savings are counted
    // from them. Only the decisions that left a message alone are trimmed.
    yield* sql`DELETE FROM workbench_routing_decisions WHERE changed=0 AND command_id IN (
      SELECT command_id FROM workbench_routing_decisions ORDER BY decided_at DESC LIMIT -1 OFFSET ${MAX_DECISIONS})`.pipe(
      Effect.mapError(storage),
    );
  });
  const lastForThread = Effect.fn("RoutingDecisionStore.lastForThread")(function* (
    threadId: string,
  ) {
    const [row] = yield* sql<{ decision_json: string; overridden: number }>`
      SELECT decision_json,overridden FROM workbench_routing_decisions
      WHERE thread_id=${threadId} ORDER BY decided_at DESC LIMIT 1`.pipe(Effect.mapError(storage));
    return row ? yield* read(row) : null;
  });
  const forThread = Effect.fn("RoutingDecisionStore.forThread")(function* (threadId: string) {
    const rows = yield* sql<{ decision_json: string; overridden: number }>`
      SELECT decision_json,overridden FROM workbench_routing_decisions
      WHERE thread_id=${threadId} ORDER BY decided_at DESC LIMIT 50`.pipe(Effect.mapError(storage));
    return yield* Effect.forEach(rows, read);
  });
  const markOverridden = Effect.fn("RoutingDecisionStore.markOverridden")(function* (
    commandId: string,
  ) {
    yield* sql`UPDATE workbench_routing_decisions SET overridden=1 WHERE command_id=${commandId}`.pipe(
      Effect.mapError(storage),
    );
  });
  const scorecard = Effect.gen(function* () {
    const [totals] = yield* sql<{
      total: number;
      changed: number | null;
      overridden: number | null;
    }>`
      SELECT count(*) AS total, sum(changed) AS changed, sum(overridden) AS overridden
      FROM workbench_routing_decisions`.pipe(Effect.mapError(storage));
    const rows = yield* sql<{ decision_json: string; overridden: number }>`
      SELECT decision_json,overridden FROM workbench_routing_decisions
      ORDER BY decided_at DESC LIMIT ${RECENT}`.pipe(Effect.mapError(storage));
    return {
      total: totals?.total ?? 0,
      changed: totals?.changed ?? 0,
      overridden: totals?.overridden ?? 0,
      recent: yield* Effect.forEach(rows, read),
    };
  });
  const movedThreads = Effect.gen(function* () {
    // A turn records the size of its last request, so these sums are a floor on what ran.
    const moves = yield* sql<{
      decided_at: string;
      from_model: string;
      to_model: string;
      input_tokens: number | null;
      cached_tokens: number | null;
      output_tokens: number | null;
    }>`
      SELECT d.decided_at,
        json_extract(d.decision_json,'$.fromModel') AS from_model,
        json_extract(d.decision_json,'$.toModel') AS to_model,
        sum(json_extract(t.payload_json,'$.tokenUsage.inputTokens')) AS input_tokens,
        sum(json_extract(t.payload_json,'$.tokenUsage.cachedInputTokens')) AS cached_tokens,
        sum(json_extract(t.payload_json,'$.tokenUsage.outputTokens')) AS output_tokens
      FROM workbench_routing_decisions d
      LEFT JOIN orchestration_v2_projection_runs r ON r.thread_id=d.thread_id
        AND json_extract(r.payload_json,'$.modelSelection.model')=json_extract(d.decision_json,'$.toModel')
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.run_id=r.run_id
      LEFT JOIN orchestration_v2_projection_provider_turns t ON t.run_attempt_id=a.attempt_id
      WHERE d.changed=1 AND d.overridden=0
        AND json_extract(d.decision_json,'$.applied')=1
        AND json_extract(d.decision_json,'$.fromModel')<>json_extract(d.decision_json,'$.toModel')
      GROUP BY d.command_id ORDER BY d.decided_at`.pipe(Effect.mapError(storage));
    const [paid] = yield* sql<{ total: number | null }>`
      SELECT sum(actual_micro_usd) AS total FROM workbench_selection_charges
      WHERE state='settled'`.pipe(Effect.mapError(storage));
    return {
      moves: moves.map((row) => ({
        decidedAt: row.decided_at,
        fromModel: row.from_model,
        toModel: row.to_model,
        inputTokens: row.input_tokens ?? 0,
        cachedInputTokens: row.cached_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
      })),
      jevMicroUsd: paid?.total ?? 0,
    };
  });
  return RoutingDecisionStore.of({
    record,
    lastForThread,
    forThread,
    markOverridden,
    scorecard,
    movedThreads,
  });
});

export const layer = Layer.effect(RoutingDecisionStore, make);
