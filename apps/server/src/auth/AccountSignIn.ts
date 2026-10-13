import { AuthAdministrativeScopes } from "@t3tools/contracts";
import type {
  AccountSignInMode,
  AuthAccessTokenResult,
  AuthBrowserSessionResult,
  AuthClientMetadata,
  AuthEnvironmentScope,
} from "@t3tools/contracts";
import {
  verifyOidcAccessToken,
  type OidcVerificationSettings,
} from "@t3tools/shared/oidcAccessToken";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { JWTVerifyGetKey } from "jose";

import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import {
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthLinkedCloudAccountReadError,
  ServerAuthScopeNotGrantedError,
  issueRemoteAccessToken,
  type ServerAuthInternalError,
} from "./EnvironmentAuth.ts";
import { timingSafeEqualUtf8 } from "./utils.ts";

/**
 * The subject recorded on sessions this service issues. Logout uses it to clear only sessions that
 * came from account sign-in, so a browser paired by code is not ended by signing out of an account.
 */
export const ACCOUNT_SIGN_IN_SESSION_SUBJECT = "account-sign-in";
const ACCOUNT_SIGN_IN_CLIENT_LABEL = "Account sign-in";

const CLOCK_SKEW_SECONDS = 30;
// Access tokens are short; a few real sign-ins a minute is already a lot for one owner.
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 20;
const MAX_TOKEN_LENGTH = 8_192;

export class AccountSignInUnavailableError extends Schema.TaggedError<AccountSignInUnavailableError>()(
  "AccountSignInUnavailableError",
  {},
) {}
export class AccountSignInRateLimitedError extends Schema.TaggedError<AccountSignInRateLimitedError>()(
  "AccountSignInRateLimitedError",
  {},
) {}
export class AccountSignInMissingTokenError extends Schema.TaggedError<AccountSignInMissingTokenError>()(
  "AccountSignInMissingTokenError",
  {},
) {}
export class AccountSignInInvalidTokenError extends Schema.TaggedError<AccountSignInInvalidTokenError>()(
  "AccountSignInInvalidTokenError",
  {},
) {}
export class AccountSignInNotOwnerError extends Schema.TaggedError<AccountSignInNotOwnerError>()(
  "AccountSignInNotOwnerError",
  {},
) {}

export type AccountSignInError =
  | AccountSignInUnavailableError
  | AccountSignInRateLimitedError
  | AccountSignInMissingTokenError
  | AccountSignInInvalidTokenError
  | AccountSignInNotOwnerError
  | ServerAuthInternalError;

/** What the token endpoint can fail with when an account access token is the credential. */
export type AccountAccessTokenExchangeError = AccountSignInError | ServerAuthScopeNotGrantedError;

/**
 * The account provider's issuer and the audience its access tokens must carry. Missing either one
 * leaves account sign-in unavailable: there is no default, so a server is never open to tokens
 * minted for some other application.
 */
const oidcVerificationConfig: Effect.Effect<Option.Option<OidcVerificationSettings>> = Effect.gen(
  function* () {
    const issuer = yield* Config.String("T3CODE_OIDC_ISSUER").pipe(Config.option);
    const audience = yield* Config.String("T3CODE_OIDC_AUDIENCE").pipe(Config.option);
    if (Option.isNone(issuer) || Option.isNone(audience)) return Option.none();
    const normalizedIssuer = issuer.value.trim().replace(/\/+$/, "");
    const normalizedAudience = audience.value.trim();
    if (!normalizedIssuer.startsWith("https://") || normalizedAudience === "") {
      return Option.none();
    }
    return Option.some({ oidcIssuer: normalizedIssuer, oidcAudience: normalizedAudience });
  },
).pipe(Effect.orElseSucceed(() => Option.none<OidcVerificationSettings>()));

export class AccountSignIn extends Context.Service<
  AccountSignIn,
  {
    /**
     * The mode clients should act on: `off` unless the setting is on, an owner account is linked
     * and the provider is configured, so a page never offers a sign-in that cannot work.
     */
    readonly effectiveMode: Effect.Effect<AccountSignInMode>;
    /** Verifies the bearer header value and, for the linked owner only, issues a browser session. */
    readonly createSession: (input: {
      readonly authorization: string | undefined;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
      },
      AccountSignInError
    >;
    /**
     * Verifies an account access token and, for the linked owner only, issues the same remote
     * client session a pairing-credential exchange issues, with the owner's administrative scopes.
     */
    readonly exchangeAccessToken: (input: {
      readonly accountAccessToken: string;
      readonly requestedScopes: ReadonlyArray<AuthEnvironmentScope> | undefined;
      readonly client: AuthClientMetadata;
      readonly proofKeyThumbprint?: string;
    }) => Effect.Effect<AuthAccessTokenResult, AccountAccessTokenExchangeError>;
  }
>()("t3/auth/AccountSignIn") {}

function readBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization.trim());
  return readToken(match?.[1]);
}

/** A token as sent in a form field: one run of non-space characters, within the length cap. */
function readToken(value: string | undefined): string | null {
  const token = value?.trim();
  return token !== undefined &&
    token !== "" &&
    token.length <= MAX_TOKEN_LENGTH &&
    !/\s/.test(token)
    ? token
    : null;
}

/** @public `keys` replaces the provider's published signing keys, for tests. */
export const make = (options?: {
  readonly oidc?: Effect.Effect<Option.Option<OidcVerificationSettings>>;
  readonly keys?: JWTVerifyGetKey;
}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const sessions = yield* SessionStore.SessionStore;
    const oidc = options?.oidc ?? oidcVerificationConfig;
    const attempts = yield* Ref.make({ windowStart: 0, count: 0 });

    const readLinkedUserId = secrets.get(CLOUD_LINKED_USER_ID).pipe(
      Effect.map((bytes) =>
        Option.isSome(bytes) ? new TextDecoder().decode(bytes.value).trim() : "",
      ),
      Effect.mapError((cause) => new ServerAuthLinkedCloudAccountReadError({ cause })),
    );

    // The setting, an owner link and the provider config must all be present. Anything missing
    // reads as "off", so the caller learns nothing about which part is missing.
    const resolveAvailability = Effect.gen(function* () {
      const mode = yield* settings.getSettings.pipe(
        Effect.map((current) => current.accountSignIn),
        Effect.orElseSucceed((): AccountSignInMode => "off"),
      );
      if (mode === "off") return null;
      const verification = yield* oidc;
      if (Option.isNone(verification)) return null;
      const linkedUserId = yield* readLinkedUserId;
      if (linkedUserId === "") return null;
      return { mode, verification: verification.value, linkedUserId };
    });

    const effectiveMode: AccountSignIn["Service"]["effectiveMode"] = resolveAvailability.pipe(
      Effect.map((availability): AccountSignInMode => availability?.mode ?? "off"),
      Effect.orElseSucceed((): AccountSignInMode => "off"),
    );

    const takeAttempt = Effect.gen(function* () {
      const now = (yield* DateTime.now).epochMilliseconds;
      const allowed = yield* Ref.modify(attempts, (state) => {
        const current =
          now - state.windowStart >= ATTEMPT_WINDOW_MS ? { windowStart: now, count: 0 } : state;
        return current.count >= MAX_ATTEMPTS_PER_WINDOW
          ? ([false, current] as const)
          : ([true, { ...current, count: current.count + 1 }] as const);
      });
      if (!allowed) return yield* new AccountSignInRateLimitedError({});
    });

    const refuse = <E extends AccountSignInError>(outcome: string, error: E) =>
      Effect.logInfo("account sign-in refused", { outcome }).pipe(
        Effect.andThen(Effect.fail(error)),
      );

    /**
     * The one owner check, shared by the cookie path and the token-exchange path. In order: the
     * setting, an owner link and the provider config; the rate limit; a well-formed token; issuer,
     * audience, signature, expiry and `typ: Bearer`; then `sub` against the linked owner.
     * `token` is the raw access token, or null when the request carried none that was usable.
     */
    const verifyOwner = (token: string | null) =>
      Effect.gen(function* () {
        const availability = yield* resolveAvailability;
        if (availability === null) {
          return yield* refuse("unavailable", new AccountSignInUnavailableError({}));
        }
        yield* takeAttempt.pipe(
          Effect.tapError(() => Effect.logWarning("account sign-in rate limited")),
        );

        if (token === null) {
          return yield* refuse("missing_token", new AccountSignInMissingTokenError({}));
        }

        const now = yield* DateTime.now;
        const verified = yield* Effect.tryPromise({
          try: () =>
            verifyOidcAccessToken(availability.verification, token, options?.keys, {
              requireBearerType: true,
              clockToleranceSeconds: CLOCK_SKEW_SECONDS,
              now: DateTime.toDate(now),
            }),
          // The failure code (a jose code such as ERR_JWT_EXPIRED) is logged, never the token.
          catch: (cause) => ({ code: readFailureCode(cause) }),
        }).pipe(
          Effect.catch((failure) =>
            refuse(`invalid_token:${failure.code}`, new AccountSignInInvalidTokenError({})),
          ),
        );

        if (!timingSafeEqualUtf8(verified.sub, availability.linkedUserId)) {
          return yield* refuse("not_owner", new AccountSignInNotOwnerError({}));
        }
      });

    const createSession: AccountSignIn["Service"]["createSession"] = (input) =>
      Effect.gen(function* () {
        yield* verifyOwner(readBearerToken(input.authorization));

        const session = yield* sessions
          .issue({
            method: "browser-session-cookie",
            subject: ACCOUNT_SIGN_IN_SESSION_SUBJECT,
            // The linked account is the owner of this environment, so it gets what the owner's
            // startup link gets: everything, including managing pairing links and shares.
            scopes: AuthAdministrativeScopes,
            client: { ...input.client, label: ACCOUNT_SIGN_IN_CLIENT_LABEL },
          })
          .pipe(
            Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })),
          );
        yield* Effect.logInfo("account sign-in accepted", { outcome: "owner" });
        return {
          response: {
            authenticated: true,
            scopes: session.scopes,
            sessionMethod: session.method,
            expiresAt: DateTime.toUtc(session.expiresAt),
          } satisfies AuthBrowserSessionResult,
          sessionToken: session.token,
        };
      }).pipe(Effect.withSpan("AccountSignIn.createSession"));

    const exchangeAccessToken: AccountSignIn["Service"]["exchangeAccessToken"] = (input) =>
      Effect.gen(function* () {
        yield* verifyOwner(readToken(input.accountAccessToken));

        const grantedScopes = input.requestedScopes ?? AuthAdministrativeScopes;
        if (!grantedScopes.every((scope) => AuthAdministrativeScopes.includes(scope))) {
          return yield* new ServerAuthScopeNotGrantedError({});
        }
        const result = yield* issueRemoteAccessToken(sessions, {
          subject: ACCOUNT_SIGN_IN_SESSION_SUBJECT,
          scopes: grantedScopes,
          client: input.client,
          label: ACCOUNT_SIGN_IN_CLIENT_LABEL,
          ...(input.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        });
        yield* Effect.logInfo("account sign-in accepted", { outcome: "owner", grant: "token" });
        return result;
      }).pipe(Effect.withSpan("AccountSignIn.exchangeAccessToken"));

    return AccountSignIn.of({ effectiveMode, createSession, exchangeAccessToken });
  });

function readFailureCode(cause: unknown): string {
  if (Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)) {
    if (/^[A-Z0-9_]{1,64}$/.test(cause.code)) return cause.code;
  }
  return cause instanceof Error && /^[a-z_]{1,64}$/.test(cause.message) ? cause.message : "unknown";
}

export const layer = Layer.effect(AccountSignIn, make());
