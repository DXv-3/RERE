import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per agent message that asked for its answer back. The row is what survives a restart:
  // it stays pending until the run that handled the message settles and the reply is delivered.
  yield* sql`CREATE TABLE workbench_agent_replies (
    source_message_id TEXT PRIMARY KEY NOT NULL,
    recipient_thread_id TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    asker_thread_id TEXT NOT NULL,
    hops INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT
  )`;
  yield* sql`CREATE INDEX workbench_agent_replies_pending ON workbench_agent_replies (recipient_thread_id) WHERE status = 'pending'`;
});
