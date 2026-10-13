import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAccountEmails } from "../persistence/schema.ts";

const MAX_EMAIL_LENGTH = 254;
// Accounts remembered per isolate, so a busy account does not cost a database call per request.
const MAX_CACHED_ACCOUNTS = 2_000;

export class AccountEmailPersistenceError extends Schema.TaggedError<AccountEmailPersistenceError>()(
  "AccountEmailPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Account email query '${this.operation}' failed`;
  }
}

/** Storage for the remembered addresses, one row per account. */
export class AccountEmailStore extends Context.Service<
  AccountEmailStore,
  {
    /**
     * Writes only when the account has no row, its address differs, or a first name is given that
     * differs. A null first name never erases one already stored.
     */
    readonly upsertIfChanged: (input: {
      readonly userId: string;
      readonly email: string;
      readonly firstName: string | null;
      readonly now: string;
    }) => Effect.Effect<void, AccountEmailPersistenceError>;
    /** The first name of an account whose verified address is `email`, or null. */
    readonly findFirstName: (input: {
      readonly email: string;
    }) => Effect.Effect<string | null, AccountEmailPersistenceError>;
    readonly find: (input: {
      readonly userId: string;
    }) => Effect.Effect<string | null, AccountEmailPersistenceError>;
  }
>()("t3code-relay/modelShares/AccountEmails/AccountEmailStore") {}

const makeStore = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const failure = (operation: string) => (cause: unknown) =>
    new AccountEmailPersistenceError({ operation, cause });
  return AccountEmailStore.of({
    upsertIfChanged: Effect.fn("relay.account_emails.upsert_if_changed")(function* (input) {
      yield* db
        .insert(relayAccountEmails)
        .values({
          userId: input.userId,
          email: input.email,
          firstName: input.firstName,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: relayAccountEmails.userId,
          set:
            input.firstName === null
              ? { email: input.email, updatedAt: input.now }
              : { email: input.email, firstName: input.firstName, updatedAt: input.now },
          setWhere:
            input.firstName === null
              ? sql`${relayAccountEmails.email} <> ${input.email}`
              : sql`${relayAccountEmails.email} <> ${input.email} or ${relayAccountEmails.firstName} is distinct from ${input.firstName}`,
        })
        .pipe(Effect.mapError(failure("upsert-if-changed")));
    }),
    findFirstName: Effect.fn("relay.account_emails.find_first_name")(function* (input) {
      const rows = yield* db
        .select({ firstName: relayAccountEmails.firstName })
        .from(relayAccountEmails)
        .where(
          and(eq(relayAccountEmails.email, input.email), isNotNull(relayAccountEmails.firstName)),
        )
        .limit(1)
        .pipe(Effect.mapError(failure("find-first-name")));
      return rows[0]?.firstName ?? null;
    }),
    find: Effect.fn("relay.account_emails.find")(function* (input) {
      const rows = yield* db
        .select({ email: relayAccountEmails.email })
        .from(relayAccountEmails)
        .where(eq(relayAccountEmails.userId, input.userId))
        .limit(1)
        .pipe(Effect.mapError(failure("find")));
      return rows[0]?.email ?? null;
    }),
  });
});

/**
 * The verified email address each account last signed in with, learned only from that account's
 * own identity token (never from a request body). It names the sharer in model share emails.
 */
export class AccountEmails extends Context.Service<
  AccountEmails,
  {
    /**
     * Remembers the address when the token's provider vouched for it and it differs from what is
     * stored. An unverified or missing address changes nothing. Never fails the caller's request.
     */
    readonly record: (input: {
      readonly userId: string;
      readonly email: string | undefined;
      readonly emailVerified: boolean | undefined;
      /** From the same token. Kept alongside the address, for greetings. */
      readonly firstName: string | null;
    }) => Effect.Effect<void>;
    /** The account's last verified address, or null when the relay has not seen one. */
    readonly lookup: (input: {
      readonly userId: string;
    }) => Effect.Effect<string | null, AccountEmailPersistenceError>;
    /** The first name of the account with this verified address, or null when unknown. */
    readonly lookupFirstName: (input: {
      readonly email: string;
    }) => Effect.Effect<string | null, AccountEmailPersistenceError>;
  }
>()("t3code-relay/modelShares/AccountEmails") {}

const make = Effect.gen(function* () {
  const store = yield* AccountEmailStore;
  const known = new Map<string, { readonly email: string; readonly firstName: string | null }>();
  const remember = (userId: string, entry: { email: string; firstName: string | null }) => {
    if (known.size >= MAX_CACHED_ACCOUNTS && !known.has(userId)) known.clear();
    known.set(userId, entry);
  };

  return AccountEmails.of({
    record: Effect.fn("relay.account_emails.record")(
      function* (input) {
        if (input.emailVerified !== true || input.email === undefined) return;
        const email = input.email.trim().toLowerCase();
        if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return;
        // What this isolate last wrote for the account; a token without a name keeps the name.
        const previous = known.get(input.userId);
        const firstName = input.firstName ?? previous?.firstName ?? null;
        if (
          previous !== undefined &&
          previous.email === email &&
          previous.firstName === firstName
        ) {
          return;
        }
        yield* store.upsertIfChanged({
          userId: input.userId,
          email,
          firstName: input.firstName,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        remember(input.userId, { email, firstName });
      },
      Effect.catchTag("AccountEmailPersistenceError", () =>
        Effect.logWarning("Could not remember an account email"),
      ),
    ),
    lookup: (input) => store.find(input),
    lookupFirstName: (input) => store.findFirstName(input),
  });
});

export const layerWithStore = Layer.effect(AccountEmails, make);
export const layer = layerWithStore.pipe(Layer.provide(Layer.effect(AccountEmailStore, makeStore)));
