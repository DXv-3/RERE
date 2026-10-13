import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sites the browser tool may type a secret on, as a JSON array of origins. Empty means any site.
  yield* sql`ALTER TABLE workbench_agent_secrets ADD COLUMN allowed_origins TEXT NOT NULL DEFAULT '[]'`;
  // A site the agent suggested when it asked. Untrusted text, shown to the owner as a suggestion.
  yield* sql`ALTER TABLE workbench_agent_secret_requests ADD COLUMN suggested_origin TEXT`;
  // One waiting request per agent and name. Keep the oldest of any duplicates a race left behind.
  yield* sql`UPDATE workbench_agent_secret_requests
    SET status = 'expired', resolved_at = created_at
    WHERE status = 'pending' AND rowid NOT IN (
      SELECT MIN(rowid) FROM workbench_agent_secret_requests
      WHERE status = 'pending' GROUP BY agent_id, name
    )`;
  yield* sql`CREATE UNIQUE INDEX workbench_agent_secret_requests_pending_name
    ON workbench_agent_secret_requests (agent_id, name) WHERE status = 'pending'`;
});
