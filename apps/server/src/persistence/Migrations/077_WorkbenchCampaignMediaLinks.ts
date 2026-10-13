import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The links this server hands out for a post's files. Only a hash of each link's secret is kept,
  // so the table cannot be used to rebuild a link. One link per file per post.
  yield* sql`CREATE TABLE workbench_campaign_media_links (
    token_hash TEXT PRIMARY KEY NOT NULL,
    post_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    real_path TEXT NOT NULL,
    root_path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX workbench_campaign_media_links_file ON workbench_campaign_media_links (post_id, relative_path)`;
});
