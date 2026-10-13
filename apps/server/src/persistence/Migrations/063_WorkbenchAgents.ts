import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_agents (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL)`;
  yield* sql`CREATE TABLE workbench_agent_contexts (command_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL)`;
  yield* sql`CREATE TABLE workbench_agent_imports (id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL)`;
});
