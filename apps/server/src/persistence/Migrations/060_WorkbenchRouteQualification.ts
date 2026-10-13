import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_route_qualifications (
    instance_id TEXT NOT NULL, model_id TEXT NOT NULL, selection_key TEXT NOT NULL,
    binding TEXT NOT NULL, evidence_json TEXT NOT NULL,
    PRIMARY KEY(instance_id, model_id, selection_key)
  )`;
});
