import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A share made for an email address also has an invitation held by the relay; `invite_id` is how
  // revoking the share takes that invitation back.
  yield* sql`ALTER TABLE workbench_model_shares ADD COLUMN recipient_email TEXT`;
  yield* sql`ALTER TABLE workbench_model_shares ADD COLUMN invite_id TEXT`;
});
