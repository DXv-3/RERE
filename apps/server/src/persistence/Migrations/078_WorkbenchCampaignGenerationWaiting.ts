import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A queued graphics-card job that is waiting for room or for its night window says why, and
  // remembers when it first waited so it can give up after a day.
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN waiting_note TEXT`;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN waiting_since TEXT`;
});
