import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_model_shares (share_id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, provider_instance_id TEXT NOT NULL, models_json TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)`;
});
