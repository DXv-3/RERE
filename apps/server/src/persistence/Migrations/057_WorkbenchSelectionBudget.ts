import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workbench_selection_charges (
      request_id TEXT PRIMARY KEY NOT NULL,
      fingerprint TEXT NOT NULL,
      reserved_day TEXT NOT NULL,
      reserved_micro_usd INTEGER NOT NULL CHECK (reserved_micro_usd > 0 AND reserved_micro_usd <= 100000),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'released')),
      receipt_id TEXT UNIQUE,
      actual_micro_usd INTEGER CHECK (actual_micro_usd >= 0 AND actual_micro_usd <= 9007199254740991),
      settled_day TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'settled' AND receipt_id IS NOT NULL AND actual_micro_usd IS NOT NULL AND settled_day IS NOT NULL)
        OR (state <> 'settled' AND receipt_id IS NULL AND actual_micro_usd IS NULL AND settled_day IS NULL)
      )
    )
  `;
  yield* sql`CREATE INDEX idx_workbench_selection_charges_state_day
    ON workbench_selection_charges (state, settled_day)`;
});
