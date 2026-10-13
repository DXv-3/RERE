import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

/**
 * Declares the Drizzle schema so a deploy regenerates migration files when
 * `src/persistence/schema.ts` changes. Nothing here applies them: the database
 * is one we run ourselves, so migrations are applied with `vp run migrate`
 * before the deploy that needs them.
 */
export const RelaySchema = Drizzle.Schema("RelaySchema", {
  schema: "./src/persistence/schema.ts",
  out: "./migrations/postgres",
  dialect: "postgres",
});

/**
 * The relay's Postgres is private. Hyperdrive reaches it through a Cloudflare
 * Tunnel hostname guarded by an Access service token, so the origin takes that
 * token's id and secret and no port.
 */
export const RelayHyperdrive = Effect.gen(function* () {
  yield* RelaySchema;
  const host = yield* Config.NonEmptyString("RELAY_DB_HOST");
  const database = yield* Config.NonEmptyString("RELAY_DB_NAME");
  const user = yield* Config.NonEmptyString("RELAY_DB_USER");
  const password = yield* Config.Redacted("RELAY_DB_PASSWORD");
  const accessClientId = yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_ID");
  const accessClientSecret = yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_SECRET");
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: {
      scheme: "postgres",
      host,
      database,
      user,
      password,
      accessClientId,
      accessClientSecret,
    },
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
    // Alchemy resolves a local origin on every deploy and rejects an Access
    // origin without one. `alchemy dev` therefore expects the same database on
    // localhost, for example through an SSH port-forward.
    dev: {
      scheme: "postgres",
      host: "127.0.0.1",
      port: 5432,
      database,
      user,
      password,
    },
  });
});
