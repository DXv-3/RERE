import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_agent_checkins (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    needs_from_owner TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    owner_note TEXT,
    reviewed_at TEXT
  )`;
  yield* sql`CREATE INDEX workbench_agent_checkins_agent_created ON workbench_agent_checkins (agent_id, created_at)`;
  yield* sql`CREATE INDEX workbench_agent_checkins_status ON workbench_agent_checkins (status)`;
  // One check-in per goal per run. NULL run ids never collide, so a check-in filed without a run is allowed.
  yield* sql`CREATE UNIQUE INDEX workbench_agent_checkins_goal_run ON workbench_agent_checkins (goal_id, run_id)`;
});
