import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Files already uploaded to cloud storage for a post, as JSON from file path to public address.
  yield* sql`ALTER TABLE workbench_campaign_posts ADD COLUMN uploaded_media TEXT NOT NULL DEFAULT '{}'`;
});
