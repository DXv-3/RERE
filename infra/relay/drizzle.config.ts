import { defineConfig } from "drizzle-kit";

// Used by `vp run migrate` to apply migrations to the relay database. The URL
// must be the owner role, reached from wherever the database is reachable.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  migrations: { table: "relay_migrations", schema: "public" },
  dbCredentials: { url: process.env.RELAY_DB_MIGRATION_URL ?? "" },
});
