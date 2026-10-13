import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_managed_skills (
    id TEXT NOT NULL, revision TEXT NOT NULL, metadata_json TEXT NOT NULL,
    stages_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    PRIMARY KEY(id, revision)
  )`;
  yield* sql`CREATE UNIQUE INDEX workbench_managed_skill_active ON workbench_managed_skills(id) WHERE enabled = 1`;
});
