import { JevAdvice, type JevRequest, type SelectionBudgetSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DAILY_CAP_MICRO_USD = 1_000_000;
// The charges table (migration 057) refuses a single reservation above $0.10.
const MAX_RESERVATION_MICRO_USD = 100_000;
const TIME_ZONE = "America/New_York";
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export class SelectionBudgetError extends Schema.TaggedError<SelectionBudgetError>()(
  "SelectionBudgetError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "budget_exhausted",
      "request_conflict",
      "invalid_transition",
      "not_found",
      "receipt_conflict",
      "storage",
    ]),
  },
) {
  override get message() {
    return `Selection budget: ${this.reason}.`;
  }
}

interface Reservation {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly reservedDay: string;
  readonly reservedMicroUsd: number;
  readonly state: "reserved" | "dispatched" | "settled" | "released";
  readonly receiptId: string | null;
  readonly actualMicroUsd: number | null;
}
interface ReserveInput {
  readonly requestId: string;
  // Hash of the bounded request, pinned price/model and policy, never the prompt itself.
  readonly fingerprint: string;
  readonly maxCostMicroUsd: number;
}

export class SelectionBudgetStore extends Context.Service<
  SelectionBudgetStore,
  {
    readonly inspect: (
      requestId: string,
      fingerprint: string,
    ) => Effect.Effect<JevRequest, SelectionBudgetError>;
    readonly snapshot: Effect.Effect<SelectionBudgetSnapshot, SelectionBudgetError>;
    readonly reserve: (input: ReserveInput) => Effect.Effect<
      {
        readonly reservation: Reservation;
        readonly created: boolean;
      },
      SelectionBudgetError
    >;
    readonly beginDispatch: (requestId: string) => Effect.Effect<boolean, SelectionBudgetError>;
    readonly releaseUnsent: (requestId: string) => Effect.Effect<void, SelectionBudgetError>;
    readonly settle: (input: {
      readonly requestId: string;
      readonly receiptId: string;
      readonly actualMicroUsd: number;
      readonly advice?: JevAdvice;
    }) => Effect.Effect<void, SelectionBudgetError>;
  }
>()("t3/routing/SelectionBudgetStore") {}

const validId = (value: string) => /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const money = (value: number) => Number.isSafeInteger(value) && value >= 0;
const encodeAdvice = Schema.encodeEffect(Schema.fromJsonString(JevAdvice));
const decodeAdvice = Schema.decodeEffect(Schema.fromJsonString(JevAdvice));
const storageError = () => new SelectionBudgetError({ reason: "storage" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Effect.map(Clock.currentTimeMillis, (millis) => ({
    day: dayFormatter.format(millis),
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(millis)),
  }));
  const read = Effect.fn("SelectionBudgetStore.read")(function* (id: string) {
    const rows = yield* sql<Reservation>`SELECT request_id AS "requestId", fingerprint,
      reserved_day AS "reservedDay", reserved_micro_usd AS "reservedMicroUsd", state,
      receipt_id AS "receiptId", actual_micro_usd AS "actualMicroUsd"
      FROM workbench_selection_charges WHERE request_id = ${id}`.pipe(
      Effect.mapError(storageError),
    );
    const row = rows[0];
    if (!row) return yield* new SelectionBudgetError({ reason: "not_found" });
    return row;
  });
  const snapshot = Effect.gen(function* () {
    const { day } = yield* now;
    const [row] = yield* sql<{
      spent: number;
      held: number;
      unresolved: number;
      overrun: number;
    }>`SELECT
      COALESCE(SUM(CASE WHEN state = 'settled' AND settled_day = ${day} THEN actual_micro_usd ELSE 0 END), 0) AS spent,
      COALESCE(SUM(CASE WHEN state IN ('reserved', 'dispatched') THEN reserved_micro_usd ELSE 0 END), 0) AS held,
      COALESCE(SUM(CASE WHEN state = 'dispatched' THEN 1 ELSE 0 END), 0) AS unresolved,
      COALESCE(MAX(CASE WHEN actual_micro_usd > reserved_micro_usd THEN 1 ELSE 0 END), 0) AS overrun
      FROM workbench_selection_charges`.pipe(Effect.mapError(storageError));
    if (!row || !money(row.spent) || !money(row.held)) return yield* storageError();
    return {
      status: "ready" as const,
      timeZone: TIME_ZONE,
      day,
      capMicroUsd: DAILY_CAP_MICRO_USD,
      spentMicroUsd: row.spent,
      heldMicroUsd: row.held,
      unresolvedRequests: row.unresolved,
      availableMicroUsd: row.overrun ? 0 : Math.max(0, DAILY_CAP_MICRO_USD - row.spent - row.held),
      halted: row.overrun === 1,
    };
  });
  const reserve = Effect.fn("SelectionBudgetStore.reserve")(function* (input: ReserveInput) {
    if (
      !validId(input.requestId) ||
      !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
      !money(input.maxCostMicroUsd) ||
      input.maxCostMicroUsd === 0 ||
      input.maxCostMicroUsd > MAX_RESERVATION_MICRO_USD
    ) {
      return yield* new SelectionBudgetError({ reason: "invalid_input" });
    }
    const { day, timestamp } = yield* now;
    // Admission is one SQLite write: separate clients cannot both spend the same remainder.
    // Unresolved reservations carry across midnight and never expire on a timer.
    const rows = yield* sql<{ request_id: string }>`INSERT INTO workbench_selection_charges
      (request_id, fingerprint, reserved_day, reserved_micro_usd, state, created_at, updated_at)
      SELECT ${input.requestId}, ${input.fingerprint}, ${day}, ${input.maxCostMicroUsd},
        'reserved', ${timestamp}, ${timestamp}
      WHERE NOT EXISTS (SELECT 1 FROM workbench_selection_charges WHERE actual_micro_usd > reserved_micro_usd)
        AND ${input.maxCostMicroUsd} <= ${DAILY_CAP_MICRO_USD} - (
          SELECT COALESCE(SUM(CASE
            WHEN state IN ('reserved', 'dispatched') THEN reserved_micro_usd
            WHEN state = 'settled' AND settled_day = ${day} THEN actual_micro_usd
            ELSE 0 END), 0) FROM workbench_selection_charges)
      ON CONFLICT(request_id) DO NOTHING RETURNING request_id`.pipe(Effect.mapError(storageError));
    const reservation = yield* read(input.requestId).pipe(
      Effect.catchTag("SelectionBudgetError", (error) =>
        error.reason === "not_found"
          ? Effect.fail(new SelectionBudgetError({ reason: "budget_exhausted" }))
          : Effect.fail(error),
      ),
    );
    if (
      reservation.fingerprint !== input.fingerprint ||
      reservation.reservedMicroUsd !== input.maxCostMicroUsd
    ) {
      return yield* new SelectionBudgetError({ reason: "request_conflict" });
    }
    return { reservation, created: rows.length === 1 };
  });
  const beginDispatch = Effect.fn("SelectionBudgetStore.beginDispatch")(function* (
    requestId: string,
  ) {
    if (!validId(requestId)) return yield* new SelectionBudgetError({ reason: "invalid_input" });
    const { day, timestamp } = yield* now;
    // Only the winning caller may send. A crash after this write leaves an uncertain charge;
    // a second worker may reconcile it, but must not send it again.
    const rows = yield* sql<{ request_id: string }>`UPDATE workbench_selection_charges
      SET state = 'dispatched', updated_at = ${timestamp}
      WHERE request_id = ${requestId} AND state = 'reserved' AND reserved_day = ${day}
        AND NOT EXISTS (SELECT 1 FROM workbench_selection_charges WHERE actual_micro_usd > reserved_micro_usd)
      RETURNING request_id`.pipe(Effect.mapError(storageError));
    return rows.length === 1;
  });
  const releaseUnsent = Effect.fn("SelectionBudgetStore.releaseUnsent")(function* (
    requestId: string,
  ) {
    if (!validId(requestId)) return yield* new SelectionBudgetError({ reason: "invalid_input" });
    const { timestamp } = yield* now;
    yield* sql`UPDATE workbench_selection_charges SET state = 'released', updated_at = ${timestamp}
      WHERE request_id = ${requestId} AND state = 'reserved'`.pipe(Effect.mapError(storageError));
    const row = yield* read(requestId);
    if (row.state !== "released")
      return yield* new SelectionBudgetError({ reason: "invalid_transition" });
  });
  const settle = Effect.fn("SelectionBudgetStore.settle")(function* (input: {
    requestId: string;
    receiptId: string;
    actualMicroUsd: number;
    advice?: JevAdvice;
  }) {
    if (!validId(input.requestId) || !validId(input.receiptId) || !money(input.actualMicroUsd)) {
      return yield* new SelectionBudgetError({ reason: "invalid_input" });
    }
    const { day, timestamp } = yield* now;
    if (
      input.advice &&
      (input.advice.requestId !== input.requestId ||
        input.advice.receiptId !== input.receiptId ||
        input.advice.costMicroUsd !== input.actualMicroUsd)
    )
      return yield* new SelectionBudgetError({ reason: "invalid_input" });
    const adviceJson = input.advice
      ? yield* encodeAdvice(input.advice).pipe(Effect.mapError(storageError))
      : null;
    // Persist real overruns instead of clamping a bill to its estimate. The overrun halts
    // all later selection admission (including after midnight) until reviewed.
    yield* sql`UPDATE workbench_selection_charges SET state = 'settled', receipt_id = ${input.receiptId},
      actual_micro_usd = ${input.actualMicroUsd}, settled_day = ${day}, advice_json = ${adviceJson}, updated_at = ${timestamp}
      WHERE request_id = ${input.requestId} AND state = 'dispatched'
        AND NOT EXISTS (SELECT 1 FROM workbench_selection_charges WHERE receipt_id = ${input.receiptId})
    `.pipe(Effect.mapError(storageError));
    const row = yield* read(input.requestId);
    if (
      row.state === "settled" &&
      row.receiptId === input.receiptId &&
      row.actualMicroUsd === input.actualMicroUsd
    )
      return;
    return yield* new SelectionBudgetError({
      reason:
        row.state === "reserved" || row.state === "released"
          ? "invalid_transition"
          : "receipt_conflict",
    });
  });
  const inspect = Effect.fn("SelectionBudgetStore.inspect")(function* (
    requestId: string,
    fingerprint: string,
  ) {
    const rows = yield* sql<{
      fingerprint: string;
      advice_json: string | null;
      state: Reservation["state"];
    }>`SELECT fingerprint, advice_json, state
      FROM workbench_selection_charges WHERE request_id = ${requestId}`.pipe(
      Effect.mapError(storageError),
    );
    const row = rows[0];
    if (!row) return { requestId, state: "new" as const, advice: null };
    if (row.fingerprint !== fingerprint)
      return yield* new SelectionBudgetError({ reason: "request_conflict" });
    const advice = row.advice_json
      ? yield* decodeAdvice(row.advice_json).pipe(Effect.mapError(storageError))
      : null;
    return { requestId, state: row.state, advice };
  });
  return SelectionBudgetStore.of({
    snapshot,
    reserve,
    beginDispatch,
    releaseUnsent,
    settle,
    inspect,
  });
});

export const layer = Layer.effect(SelectionBudgetStore, make);
