import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Image and video jobs. A job with a provider id is polled again after a restart and never
  // submitted twice. The list-shaped columns hold JSON; nothing queries inside them.
  yield* sql`CREATE TABLE workbench_campaign_generation_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    campaign_id TEXT,
    kind TEXT NOT NULL,
    connector TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    options TEXT NOT NULL,
    status TEXT NOT NULL,
    provider_job_id TEXT,
    estimated_usd REAL,
    estimate_note TEXT NOT NULL,
    result_paths TEXT NOT NULL,
    error TEXT,
    requested_by TEXT NOT NULL,
    source_thread_id TEXT,
    started_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_campaign_generation_jobs_client ON workbench_campaign_generation_jobs (client_id, created_at)`;
  yield* sql`CREATE INDEX workbench_campaign_generation_jobs_open ON workbench_campaign_generation_jobs (status) WHERE status IN ('queued', 'running')`;
});
