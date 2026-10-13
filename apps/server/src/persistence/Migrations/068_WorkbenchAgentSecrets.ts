import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Metadata only. A secret's value lives in the server secret store and is never a column.
  yield* sql`CREATE TABLE workbench_agent_secrets (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  )`;
  yield* sql`CREATE UNIQUE INDEX workbench_agent_secrets_agent_name ON workbench_agent_secrets (agent_id, name)`;
  yield* sql`CREATE TABLE workbench_agent_secret_requests (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    reason TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`;
  yield* sql`CREATE INDEX workbench_agent_secret_requests_status ON workbench_agent_secret_requests (status, created_at)`;
  yield* sql`CREATE INDEX workbench_agent_secret_requests_agent ON workbench_agent_secret_requests (agent_id, status)`;
});
