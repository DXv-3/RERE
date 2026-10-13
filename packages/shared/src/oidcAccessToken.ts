import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifies an access token from the account sign-in provider (an OpenID Connect issuer such as a
 * Keycloak realm) against the issuer's published signing keys. Callers mostly need proof of who the
 * caller is, so it reads `sub`, plus `email` and `email_verified` for the few callers that match on
 * an address (they must check `emailVerified`). Used by the relay and by an environment server
 * that lets its linked owner sign in with an account.
 */

export interface OidcVerificationSettings {
  readonly oidcIssuer: string;
  /** The token must name this audience, so a token minted for another app is refused. */
  readonly oidcAudience: string;
}

export interface OidcVerificationOptions {
  /**
   * Refuse a token whose `typ` claim is not `Bearer`. Keycloak marks access tokens `Bearer` and
   * ID, refresh and offline tokens otherwise, so this keeps a non-access token from being accepted.
   */
  readonly requireBearerType?: boolean;
  /** Allowed clock difference in seconds for `exp` and `nbf`. Defaults to none. */
  readonly clockToleranceSeconds?: number;
  /** The moment to judge expiry against. Defaults to now. */
  readonly now?: Date;
}

// One key set per issuer for the life of the isolate; jose refetches when it sees an unknown key.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Keycloak publishes its signing keys here; it is the only provider this deployment uses. */
export function oidcJwksUrl(issuer: string): URL {
  return new URL(`${issuer.replace(/\/+$/, "")}/protocol/openid-connect/certs`);
}

function remoteKeys(issuer: string): JWTVerifyGetKey {
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(oidcJwksUrl(issuer));
    keySets.set(issuer, keys);
  }
  return keys;
}

const MAX_FIRST_NAME_LENGTH = 60;

/** One line, whitespace collapsed, at most 60 characters; null when nothing is left. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // oxlint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1F\x7F\s]+/g, " ").trim();
  if (cleaned === "") return null;
  return Array.from(cleaned).slice(0, MAX_FIRST_NAME_LENGTH).join("");
}

/**
 * The first name a greeting can use: the `given_name` claim, otherwise the first word of `name`.
 * A name is only a greeting, never an identity, so it is cleaned but not otherwise trusted.
 */
function readFirstName(claims: Readonly<Record<string, unknown>>): string | null {
  const given = cleanName(claims.given_name);
  if (given !== null) return given;
  const full = cleanName(claims.name);
  return full === null ? null : (cleanName(full.split(" ")[0]) ?? null);
}

/** `keys` defaults to the issuer's published signing keys. */
export async function verifyOidcAccessToken(
  settings: OidcVerificationSettings,
  token: string,
  keys: JWTVerifyGetKey = remoteKeys(settings.oidcIssuer.replace(/\/+$/, "")),
  options: OidcVerificationOptions = {},
): Promise<{
  readonly sub: string;
  /** Lower-cased. Only trust it when `emailVerified` is true. */
  readonly email: string | null;
  /** True only when the provider says it verified the address. */
  readonly emailVerified: boolean;
  /** The person's first name for greetings, or null. See `readFirstName`. */
  readonly firstName: string | null;
}> {
  const issuer = settings.oidcIssuer.replace(/\/+$/, "");
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: settings.oidcAudience,
    algorithms: ["RS256", "ES256", "PS256"],
    requiredClaims: ["exp"],
    ...(options.clockToleranceSeconds === undefined
      ? {}
      : { clockTolerance: options.clockToleranceSeconds }),
    ...(options.now === undefined ? {} : { currentDate: options.now }),
  });
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new Error("missing_subject");
  }
  if (options.requireBearerType && payload.typ !== "Bearer") {
    throw new Error("not_an_access_token");
  }
  const email =
    typeof payload.email === "string" && payload.email.trim() !== ""
      ? payload.email.trim().toLowerCase()
      : null;
  return {
    sub: payload.sub,
    email,
    emailVerified: payload.email_verified === true,
    firstName: readFirstName(payload),
  };
}
