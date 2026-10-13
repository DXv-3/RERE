import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, gte, isNull } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayModelShareInvites } from "../persistence/schema.ts";

export class ModelShareInvitePersistenceError extends Schema.TaggedError<ModelShareInvitePersistenceError>()(
  "ModelShareInvitePersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Model share invite query '${this.operation}' failed`;
  }
}

export interface ModelShareInviteRow {
  readonly inviteId: string;
  readonly ownerUserId: string;
  readonly environmentId: string;
  readonly shareId: string;
  readonly recipientEmail: string;
  readonly shareBaseUrl: string;
  readonly models: ReadonlyArray<string>;
  readonly label: string;
  readonly sealedToken: string;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
}

/**
 * Storage for invites. Every read is keyed by whoever is asking (the environment, or the verified
 * recipient email), so a caller cannot reach a row that is not theirs.
 */
export class ModelShareInviteStore extends Context.Service<
  ModelShareInviteStore,
  {
    readonly insert: (
      row: ModelShareInviteRow,
    ) => Effect.Effect<void, ModelShareInvitePersistenceError>;
    /** Invites the owner has made that nobody has accepted or revoked yet, up to `limit`. */
    readonly countOpenForOwner: (input: {
      readonly ownerUserId: string;
      readonly limit: number;
    }) => Effect.Effect<number, ModelShareInvitePersistenceError>;
    /**
     * Addresses the owner has invited since `since`, whatever became of those invites (open,
     * accepted or revoked), up to `limit`. Bounds how often one account can cause email.
     */
    readonly recentRecipientsForOwner: (input: {
      readonly ownerUserId: string;
      readonly since: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<string>, ModelShareInvitePersistenceError>;
    readonly listForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<ModelShareInviteRow>, ModelShareInvitePersistenceError>;
    /** Revokes and wipes the sealed token. False when the environment has no such live invite. */
    readonly revokeForEnvironment: (input: {
      readonly environmentId: string;
      readonly inviteId: string;
      readonly now: string;
    }) => Effect.Effect<boolean, ModelShareInvitePersistenceError>;
    /** Invites addressed to `email` that are neither accepted nor revoked. */
    readonly listOpenForEmail: (input: {
      readonly email: string;
    }) => Effect.Effect<ReadonlyArray<ModelShareInviteRow>, ModelShareInvitePersistenceError>;
    /** Marks accepted and wipes the sealed token. False when `email` has no such open invite. */
    readonly markAccepted: (input: {
      readonly inviteId: string;
      readonly email: string;
      readonly now: string;
    }) => Effect.Effect<boolean, ModelShareInvitePersistenceError>;
  }
>()("t3code-relay/modelShares/ModelShareInviteStore") {}

const columns = {
  inviteId: relayModelShareInvites.inviteId,
  ownerUserId: relayModelShareInvites.ownerUserId,
  environmentId: relayModelShareInvites.environmentId,
  shareId: relayModelShareInvites.shareId,
  recipientEmail: relayModelShareInvites.recipientEmail,
  shareBaseUrl: relayModelShareInvites.shareBaseUrl,
  modelsJson: relayModelShareInvites.modelsJson,
  label: relayModelShareInvites.label,
  sealedToken: relayModelShareInvites.sealedToken,
  createdAt: relayModelShareInvites.createdAt,
  acceptedAt: relayModelShareInvites.acceptedAt,
};

function toRow(row: {
  readonly inviteId: string;
  readonly ownerUserId: string;
  readonly environmentId: string;
  readonly shareId: string;
  readonly recipientEmail: string;
  readonly shareBaseUrl: string;
  readonly modelsJson: ReadonlyArray<string>;
  readonly label: string;
  readonly sealedToken: string;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
}): ModelShareInviteRow {
  const { modelsJson, ...rest } = row;
  return { ...rest, models: modelsJson };
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const failure = (operation: string) => (cause: unknown) =>
    new ModelShareInvitePersistenceError({ operation, cause });

  return ModelShareInviteStore.of({
    insert: Effect.fn("relay.model_share_invites.insert")(function* (row) {
      const { models, ...rest } = row;
      yield* db
        .insert(relayModelShareInvites)
        .values({ ...rest, modelsJson: models, revokedAt: null })
        .pipe(Effect.mapError(failure("insert")));
    }),

    countOpenForOwner: Effect.fn("relay.model_share_invites.count_open_for_owner")(
      function* (input) {
        const rows = yield* db
          .select({ inviteId: relayModelShareInvites.inviteId })
          .from(relayModelShareInvites)
          .where(
            and(
              eq(relayModelShareInvites.ownerUserId, input.ownerUserId),
              isNull(relayModelShareInvites.revokedAt),
              isNull(relayModelShareInvites.acceptedAt),
            ),
          )
          .limit(input.limit)
          .pipe(Effect.mapError(failure("count-open-for-owner")));
        return rows.length;
      },
    ),

    recentRecipientsForOwner: Effect.fn("relay.model_share_invites.recent_recipients_for_owner")(
      function* (input) {
        const rows = yield* db
          .select({ recipientEmail: relayModelShareInvites.recipientEmail })
          .from(relayModelShareInvites)
          .where(
            and(
              eq(relayModelShareInvites.ownerUserId, input.ownerUserId),
              gte(relayModelShareInvites.createdAt, input.since),
            ),
          )
          .limit(input.limit)
          .pipe(Effect.mapError(failure("recent-recipients-for-owner")));
        return rows.map((row) => row.recipientEmail);
      },
    ),

    listForEnvironment: Effect.fn("relay.model_share_invites.list_for_environment")(
      function* (input) {
        const rows = yield* db
          .select(columns)
          .from(relayModelShareInvites)
          .where(
            and(
              eq(relayModelShareInvites.environmentId, input.environmentId),
              isNull(relayModelShareInvites.revokedAt),
            ),
          )
          .pipe(Effect.mapError(failure("list-for-environment")));
        return rows.map(toRow);
      },
    ),

    revokeForEnvironment: Effect.fn("relay.model_share_invites.revoke_for_environment")(
      function* (input) {
        const rows = yield* db
          .update(relayModelShareInvites)
          .set({ revokedAt: input.now, sealedToken: "" })
          .where(
            and(
              eq(relayModelShareInvites.inviteId, input.inviteId),
              eq(relayModelShareInvites.environmentId, input.environmentId),
              isNull(relayModelShareInvites.revokedAt),
            ),
          )
          .returning({ inviteId: relayModelShareInvites.inviteId })
          .pipe(Effect.mapError(failure("revoke-for-environment")));
        return rows.length > 0;
      },
    ),

    listOpenForEmail: Effect.fn("relay.model_share_invites.list_open_for_email")(function* (input) {
      const rows = yield* db
        .select(columns)
        .from(relayModelShareInvites)
        .where(
          and(
            eq(relayModelShareInvites.recipientEmail, input.email),
            isNull(relayModelShareInvites.revokedAt),
            isNull(relayModelShareInvites.acceptedAt),
          ),
        )
        .pipe(Effect.mapError(failure("list-open-for-email")));
      return rows.map(toRow);
    }),

    markAccepted: Effect.fn("relay.model_share_invites.mark_accepted")(function* (input) {
      const rows = yield* db
        .update(relayModelShareInvites)
        .set({ acceptedAt: input.now, sealedToken: "" })
        .where(
          and(
            eq(relayModelShareInvites.inviteId, input.inviteId),
            eq(relayModelShareInvites.recipientEmail, input.email),
            isNull(relayModelShareInvites.revokedAt),
            isNull(relayModelShareInvites.acceptedAt),
          ),
        )
        .returning({ inviteId: relayModelShareInvites.inviteId })
        .pipe(Effect.mapError(failure("mark-accepted")));
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(ModelShareInviteStore, make);
