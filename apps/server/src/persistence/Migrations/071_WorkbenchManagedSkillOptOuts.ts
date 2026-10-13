import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A skill the user switched off by hand. An automatic sync never turns these back on.
  yield* sql`CREATE TABLE workbench_managed_skill_opt_outs (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL)`;
});
