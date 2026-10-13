import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_run_observations (
    attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    instance_id TEXT NOT NULL, selection_json TEXT NOT NULL,
    observed_at INTEGER NOT NULL, snapshot_checked_at TEXT, binding TEXT,
    state TEXT NOT NULL, conflicted INTEGER NOT NULL DEFAULT 0
  )`;
});
