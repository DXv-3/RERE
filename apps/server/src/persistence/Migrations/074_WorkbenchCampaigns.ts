import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workbench_campaign_clients (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    brand_notes TEXT NOT NULL,
    do_not_say TEXT NOT NULL,
    publishing_client_id TEXT,
    approval_mode TEXT NOT NULL,
    monthly_spend_cap_usd REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // A null mode means the campaign follows its client.
  yield* sql`CREATE TABLE workbench_campaigns (
    id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    approval_mode TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_campaigns_client ON workbench_campaigns (client_id)`;
  // The list-shaped columns hold JSON; nothing queries inside them.
  yield* sql`CREATE TABLE workbench_campaign_posts (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL,
    status TEXT NOT NULL,
    platforms TEXT NOT NULL,
    captions TEXT NOT NULL,
    media_paths TEXT NOT NULL,
    media_urls TEXT NOT NULL,
    title TEXT,
    destination_url TEXT,
    scheduled_at TEXT,
    source_thread_id TEXT,
    created_by TEXT NOT NULL,
    approval TEXT,
    publish_results TEXT NOT NULL,
    change_request TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_campaign_posts_campaign ON workbench_campaign_posts (campaign_id)`;
  yield* sql`CREATE INDEX workbench_campaign_posts_due ON workbench_campaign_posts (status) WHERE status IN ('approved', 'scheduled', 'publishing')`;
  // One row per platform per attempt. It outlives the post it describes: the record of what went
  // out, under which mode and on whose approval, is kept after a post or client is deleted.
  yield* sql`CREATE TABLE workbench_campaign_publish_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    mode TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    result TEXT NOT NULL,
    link TEXT,
    error TEXT,
    at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX workbench_campaign_publish_log_post ON workbench_campaign_publish_log (post_id)`;
});
