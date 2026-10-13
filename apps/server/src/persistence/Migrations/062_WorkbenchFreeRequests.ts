import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_free_requests (
    request_key TEXT PRIMARY KEY, route_key TEXT NOT NULL, claim_token TEXT NOT NULL,
    instance_id TEXT NOT NULL, session_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    model TEXT NOT NULL, endpoint TEXT NOT NULL, requested_fields TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('dispatched','completed_free','uncertain')),
    claimed_at INTEGER NOT NULL, settled_at INTEGER, receipt_json TEXT
  )`;
  yield* sql`CREATE INDEX workbench_free_requests_route ON workbench_free_requests(route_key,state)`;
});
