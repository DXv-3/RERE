import { MODEL_SHARE_ROUTE_PREFIX } from "@t3tools/contracts";
import {
  type RelayModelShareInviteCreateRequest,
  RelayModelShareInviteInvalidReason,
  type RelayModelShareInviteOffer,
  type RelayModelShareInviteStatusRecord,
  RELAY_MODEL_SHARE_INVITE_MAX_EMAIL_LENGTH,
  RELAY_MODEL_SHARE_INVITE_MAX_MODELS,
  RELAY_MODEL_SHARE_INVITE_MAX_OPEN_PER_OWNER,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import { openModelShareToken, sealModelShareToken } from "./ModelShareSeal.ts";
import * as AccountEmails from "./AccountEmails.ts";
import * as Mailer from "./ModelShareInviteMailer.ts";
import * as Store from "./ModelShareInviteStore.ts";

// Email guard. The open-invite cap alone does not bound email: revoking frees a slot, so an account
// could revoke and invite again without end. Counting every invite made in the last day, revoked or
// not, bounds it: at most this many invites can send email per account per day, and one address
// gets at most one email from an account per day (the invite itself still works either way).
const EMAIL_WINDOW_MILLIS = 24 * 60 * 60 * 1000;
const MAX_EMAILS_PER_OWNER_PER_WINDOW = 20;

const MAX_MODEL_LENGTH = 200;
const MAX_TOKEN_LENGTH = 512;
// Same rules the recipient's app applies to a pasted share code.
// oxlint-disable-next-line no-control-regex
const MODEL_NAME_PATTERN = /^[^\x00-\x1F\x7F,]+$/;
const TOKEN_PATTERN = /^[\x21-\x7E]+$/;
// One address: no whitespace, one @, a dotted domain. The sign-in provider verifies real ownership.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export class ModelShareInviteInvalid extends Schema.TaggedError<ModelShareInviteInvalid>()(
  "ModelShareInviteInvalid",
  { reason: RelayModelShareInviteInvalidReason },
) {
  override get message(): string {
    return `Model share invite is invalid: ${this.reason}`;
  }
}

export class ModelShareInviteLimitReached extends Schema.TaggedError<ModelShareInviteLimitReached>()(
  "ModelShareInviteLimitReached",
  { maxOpenInvites: Schema.Number },
) {
  override get message(): string {
    return `At most ${this.maxOpenInvites} model share invites can wait to be accepted`;
  }
}

/** Also returned for another account's invite, so ids cannot be probed. */
export class ModelShareInviteNotFound extends Schema.TaggedError<ModelShareInviteNotFound>()(
  "ModelShareInviteNotFound",
  {},
) {
  override get message(): string {
    return "Model share invite not found";
  }
}

export class ModelShareInviteUnavailable extends Schema.TaggedError<ModelShareInviteUnavailable>()(
  "ModelShareInviteUnavailable",
  {},
) {
  override get message(): string {
    return "Model share invites are not configured on this relay";
  }
}

export type ModelShareInviteError =
  | ModelShareInviteInvalid
  | ModelShareInviteLimitReached
  | ModelShareInviteNotFound
  | ModelShareInviteUnavailable
  | Store.ModelShareInvitePersistenceError
  | EnvironmentLinks.EnvironmentLinkLookupPersistenceError;

/** The address in the form invites are stored and matched: trimmed and lower-cased. */
export function normalizeInviteEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length > 0 &&
    email.length <= RELAY_MODEL_SHARE_INVITE_MAX_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(email)
    ? email
    : null;
}

function sealContext(inviteId: string, email: string): string {
  return `${inviteId}|${email}`;
}

/**
 * Model shares offered to an email address. The share token is a bearer credential for the
 * sharer's hardware, so it is sealed at rest and only ever returned to the recipient whose account
 * token carries that exact address as verified.
 */
export class ModelShareInvites extends Context.Service<
  ModelShareInvites,
  {
    /** `emailed` is true only when the recipient was sent an email about this invite. */
    readonly create: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly request: RelayModelShareInviteCreateRequest;
    }) => Effect.Effect<
      { readonly inviteId: string; readonly emailed: boolean },
      ModelShareInviteError
    >;
    readonly listForEnvironment: (input: {
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<RelayModelShareInviteStatusRecord>, ModelShareInviteError>;
    readonly revoke: (input: {
      readonly environmentId: string;
      readonly inviteId: string;
    }) => Effect.Effect<void, ModelShareInviteError>;
    /** Empty unless the caller's token has a verified email, and then only that address's invites. */
    readonly offersForRecipient: (input: {
      readonly email: string | undefined;
      readonly emailVerified: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<RelayModelShareInviteOffer>, ModelShareInviteError>;
    readonly accept: (input: {
      readonly inviteId: string;
      readonly email: string | undefined;
      readonly emailVerified: boolean | undefined;
    }) => Effect.Effect<void, ModelShareInviteError>;
  }
>()("t3code-relay/modelShares/ModelShareInvites") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const store = yield* Store.ModelShareInviteStore;
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const crypto = yield* Crypto.Crypto;
  const mailer = yield* Mailer.ModelShareInviteMailer;
  const accountEmails = yield* AccountEmails.AccountEmails;

  /**
   * The sharing account's verified address, learned by the relay from that account's own identity
   * token. Nothing in the create request can supply it. Null means no email is sent: a message
   * from an unnamed sender reads like spam.
   */
  const senderEmail = (ownerUserId: string) =>
    accountEmails
      .lookup({ userId: ownerUserId })
      .pipe(
        Effect.catchTag("AccountEmailPersistenceError", () =>
          Effect.logWarning("Could not read the sharing account's email").pipe(Effect.as(null)),
        ),
      );

  /** Whether this owner may cause one more email to `email`, judged before the new invite exists. */
  const mayEmail = (ownerUserId: string, email: string) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const recent = yield* store.recentRecipientsForOwner({
        ownerUserId,
        since: DateTime.formatIso(DateTime.subtract(now, { milliseconds: EMAIL_WINDOW_MILLIS })),
        limit: MAX_EMAILS_PER_OWNER_PER_WINDOW,
      });
      return recent.length < MAX_EMAILS_PER_OWNER_PER_WINDOW && !recent.includes(email);
    }).pipe(
      // The email is optional; a failed check means no email, never a failed invite.
      Effect.catchTag("ModelShareInvitePersistenceError", () =>
        Effect.logWarning("Model share invite email check failed").pipe(Effect.as(false)),
      ),
    );

  const invalid = (reason: typeof RelayModelShareInviteInvalidReason.Type) =>
    new ModelShareInviteInvalid({ reason });
  const requireSecret = () => {
    const secret = config.modelShareSealingKey;
    return secret === undefined
      ? Effect.fail(new ModelShareInviteUnavailable())
      : Effect.succeed(secret);
  };
  const verifiedEmail = (input: {
    readonly email: string | undefined;
    readonly emailVerified: boolean | undefined;
  }) =>
    input.emailVerified === true && input.email !== undefined
      ? normalizeInviteEmail(input.email)
      : null;

  return ModelShareInvites.of({
    create: Effect.fn("relay.model_share_invites.create")(function* (input) {
      const { request } = input;
      const email = normalizeInviteEmail(request.recipientEmail);
      if (email === null) return yield* invalid("invalid_email");
      const models = request.models.map((model) => model.trim());
      if (
        models.length === 0 ||
        models.length > RELAY_MODEL_SHARE_INVITE_MAX_MODELS ||
        new Set(models).size !== models.length ||
        models.some((model) => model.length > MAX_MODEL_LENGTH || !MODEL_NAME_PATTERN.test(model))
      ) {
        return yield* invalid("invalid_models");
      }
      if (request.token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(request.token)) {
        return yield* invalid("invalid_token");
      }
      const secret = yield* requireSecret();

      // The invite's address and sender label come from the account's own link record, not from
      // the caller, and the environment must be linked to the account it names.
      const link = yield* links.getForUser({
        userId: request.ownerUserId,
        environmentId: input.environmentId,
      });
      if (link === null || link.environmentPublicKey !== input.environmentPublicKey) {
        return yield* invalid("not_linked");
      }
      let origin: string;
      try {
        const url = new URL(link.endpoint.httpBaseUrl);
        if (url.protocol !== "https:" || url.hostname === "") {
          return yield* invalid("address_not_https");
        }
        origin = url.origin;
      } catch {
        return yield* invalid("address_not_https");
      }

      const open = yield* store.countOpenForOwner({
        ownerUserId: request.ownerUserId,
        limit: RELAY_MODEL_SHARE_INVITE_MAX_OPEN_PER_OWNER,
      });
      if (open >= RELAY_MODEL_SHARE_INVITE_MAX_OPEN_PER_OWNER) {
        return yield* new ModelShareInviteLimitReached({
          maxOpenInvites: RELAY_MODEL_SHARE_INVITE_MAX_OPEN_PER_OWNER,
        });
      }

      const sender = mailer.enabled ? yield* senderEmail(request.ownerUserId) : null;
      const emailAllowed = sender !== null ? yield* mayEmail(request.ownerUserId, email) : false;
      // Only people who already have an account have a first name on file; everyone else is "Hi,".
      const recipientFirstName = emailAllowed
        ? yield* accountEmails
            .lookupFirstName({ email })
            .pipe(
              Effect.catchTag("AccountEmailPersistenceError", () =>
                Effect.logWarning("Could not read the recipient's first name").pipe(
                  Effect.as(null),
                ),
              ),
            )
        : null;

      const inviteId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const sealedToken = yield* Effect.promise(() =>
        sealModelShareToken({
          secret,
          token: request.token,
          context: sealContext(inviteId, email),
        }),
      );
      yield* store.insert({
        inviteId,
        ownerUserId: request.ownerUserId,
        environmentId: input.environmentId,
        shareId: request.shareId,
        recipientEmail: email,
        shareBaseUrl: `${origin}${MODEL_SHARE_ROUTE_PREFIX}`,
        models,
        label: link.label,
        sealedToken,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        acceptedAt: null,
      });
      // The invite is stored. The email is a courtesy on top: it cannot fail or hold up the invite
      // beyond the mailer's own timeout.
      const emailed =
        emailAllowed && sender !== null
          ? yield* mailer.send({
              inviteId,
              senderEmail: sender,
              recipientFirstName,
              recipientEmail: email,
              machine: link.label,
              models,
            })
          : false;
      return { inviteId, emailed };
    }),

    listForEnvironment: Effect.fn("relay.model_share_invites.list_for_environment")(
      function* (input) {
        const rows = yield* store.listForEnvironment(input);
        return rows.map((row) => ({
          inviteId: row.inviteId,
          shareId: row.shareId,
          recipientEmail: row.recipientEmail,
          createdAt: row.createdAt,
          acceptedAt: row.acceptedAt,
        }));
      },
    ),

    revoke: Effect.fn("relay.model_share_invites.revoke")(function* (input) {
      const revoked = yield* store.revokeForEnvironment({
        ...input,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      if (!revoked) return yield* new ModelShareInviteNotFound();
    }),

    offersForRecipient: Effect.fn("relay.model_share_invites.offers_for_recipient")(
      function* (input) {
        const email = verifiedEmail(input);
        if (email === null) return [];
        const secret = yield* requireSecret();
        const rows = yield* store.listOpenForEmail({ email });
        const offers: Array<RelayModelShareInviteOffer> = [];
        for (const row of rows) {
          // The query is keyed by email; re-check so a store bug cannot leak across addresses.
          if (row.recipientEmail !== email) continue;
          const token = yield* Effect.promise(() =>
            openModelShareToken({
              secret,
              sealed: row.sealedToken,
              context: sealContext(row.inviteId, row.recipientEmail),
            }),
          );
          if (token === null) {
            yield* Effect.logWarning("Model share invite could not be opened", {
              inviteId: row.inviteId,
            });
            continue;
          }
          offers.push({
            inviteId: row.inviteId,
            label: row.label,
            models: row.models,
            baseUrl: row.shareBaseUrl,
            token,
            createdAt: row.createdAt,
          });
        }
        return offers;
      },
    ),

    accept: Effect.fn("relay.model_share_invites.accept")(function* (input) {
      const email = verifiedEmail(input);
      if (email === null) return yield* new ModelShareInviteNotFound();
      const accepted = yield* store.markAccepted({
        inviteId: input.inviteId,
        email,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      if (!accepted) return yield* new ModelShareInviteNotFound();
    }),
  });
});

export const layer = Layer.effect(ModelShareInvites, make);
