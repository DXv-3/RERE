import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN reserved_usd REAL`;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN allowance_usd REAL`;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN request_key TEXT`;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN request_fingerprint TEXT`;
  yield* sql`ALTER TABLE workbench_campaign_generation_jobs ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'not-submitted'`;
  yield* sql`UPDATE workbench_campaign_generation_jobs SET reserved_usd = estimated_usd,
    submission_state = CASE WHEN provider_job_id IS NOT NULL THEN 'submitted'
      WHEN started_at IS NOT NULL THEN 'uncertain' ELSE 'not-submitted' END`;
  yield* sql`CREATE UNIQUE INDEX workbench_generation_request_key ON workbench_campaign_generation_jobs(request_key) WHERE request_key IS NOT NULL`;
  yield* sql`CREATE TABLE workbench_campaign_external_expenses (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    campaign_id TEXT,
    request_key TEXT UNIQUE NOT NULL,
    allowance_usd REAL NOT NULL CHECK(allowance_usd > 0),
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_generation_campaign_spend ON workbench_campaign_generation_jobs(campaign_id)`;
  yield* sql`CREATE INDEX workbench_external_expenses_campaign ON workbench_campaign_external_expenses(campaign_id)`;
  yield* sql`CREATE INDEX workbench_external_expenses_client ON workbench_campaign_external_expenses(client_id, created_at)`;
});
