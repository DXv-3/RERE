import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_routing_decisions (
    command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, decided_at TEXT NOT NULL,
    changed INTEGER NOT NULL, overridden INTEGER NOT NULL DEFAULT 0, decision_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_routing_decisions_thread
    ON workbench_routing_decisions(thread_id, decided_at)`;
});
