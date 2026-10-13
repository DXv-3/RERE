import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_push_devices (device_id TEXT PRIMARY KEY NOT NULL, document TEXT NOT NULL, updated_at TEXT NOT NULL)`;
});
