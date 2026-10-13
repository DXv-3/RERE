import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_content_studios (
    campaign_id TEXT PRIMARY KEY REFERENCES workbench_campaigns(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    document TEXT NOT NULL
  )`;
});
