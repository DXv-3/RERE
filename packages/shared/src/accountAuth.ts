/**
 * Account sign-in against an OpenID Connect issuer (a Keycloak realm), shared by web, desktop,
 * mobile and the server. Every client is a public client using the authorization-code flow with
 * PKCE; nothing here holds a secret. Callers own storage, the browser hand-off and `fetch`.
 */

const ACCOUNT_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export interface AccountAuthConfig {
  /** Issuer URL, for example `https://login.example.com/realms/codewrench`. */
  readonly issuer: string;
  readonly clientId: string;
}

export interface AccountEndpoints {
  readonly authorization: string;
  /** Same request as `authorization`, but opens on the sign-up form. */
  readonly registration: string;
  readonly token: string;
  readonly deviceAuthorization: string;
  readonly endSession: string;
  /** Where a signed-in user manages their profile, password and sessions. */
  readonly account: string;
}

export function accountEndpoints(issuer: string): AccountEndpoints {
  const base = issuer.replace(/\/+$/, "");
  const protocol = `${base}/protocol/openid-connect`;
  return {
    authorization: `${protocol}/auth`,
    registration: `${protocol}/registrations`,
    token: `${protocol}/token`,
    deviceAuthorization: `${protocol}/auth/device`,
    endSession: `${protocol}/logout`,
    account: `${base}/account`,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** A fresh verifier and its S256 challenge. Keep the verifier until the code is exchanged. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function createAuthState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The page to send the user to. `sign_up` opens the provider's registration form. */
export function buildAccountAuthorizeUrl(input: {
  readonly config: AccountAuthConfig;
  readonly mode: "sign_in" | "sign_up";
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string;
}): string {
  const endpoints = accountEndpoints(input.config.issuer);
  const url = new URL(input.mode === "sign_up" ? endpoints.registration : endpoints.authorization);
  url.searchParams.set("client_id", input.config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ACCOUNT_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/** The code from a callback URL, or the reason there is none. The state must match the request. */
export function readAccountCallback(
  callbackUrl: string,
  expectedState: string,
):
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: "state_mismatch" | "denied" | "missing_code" } {
  const url = new URL(callbackUrl);
  // Custom-scheme redirects can carry the parameters in the fragment on some platforms.
  const params =
    url.searchParams.has("code") || url.searchParams.has("error")
      ? url.searchParams
      : new URLSearchParams(url.hash.replace(/^#/, ""));
  if (params.get("error")) return { ok: false, reason: "denied" };
  if (params.get("state") !== expectedState) return { ok: false, reason: "state_mismatch" };
  const code = params.get("code");
  return code ? { ok: true, code } : { ok: false, reason: "missing_code" };
}

export function accountCodeExchangeBody(input: {
  readonly config: AccountAuthConfig;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.config.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
}

export function accountRefreshBody(config: AccountAuthConfig, refreshToken: string) {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
}

/**
 * True when the issuer itself says the refresh token is dead (expired, revoked, session ended).
 * Only then should a client forget the session. Any other failure, including a 4xx from a proxy
 * in front of the issuer (a challenge page, a rate limit), leaves the user signed in to retry
 * later: the account exists so people stay connected, not so they keep proving who they are.
 */
export function accountRefreshRejected(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).error === "invalid_grant"
  );
}

/** What a client stores between launches. Keep it in the platform's secure storage. */
export interface AccountTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresAtEpochMs: number;
}

/** Tokens from a token-endpoint response, or null when the response is not one. */
export function parseAccountTokenResponse(body: unknown, nowEpochMs: number): AccountTokens | null {
  if (typeof body !== "object" || body === null) return null;
  const json = body as Record<string, unknown>;
  if (typeof json.access_token !== "string" || json.access_token === "") return null;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 60;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
    expiresAtEpochMs: nowEpochMs + expiresIn * 1000,
  };
}

/** True when the access token should be refreshed before use. */
export function accountTokensNeedRefresh(tokens: AccountTokens, nowEpochMs: number): boolean {
  return tokens.expiresAtEpochMs - nowEpochMs < 30_000;
}

export interface AccountIdentity {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
}

/**
 * Who the tokens belong to, read from the token without verifying it. For display and for
 * keying local state only; the relay verifies the token itself.
 */
export function readAccountIdentity(tokens: AccountTokens): AccountIdentity | null {
  const payload = (tokens.idToken ?? tokens.accessToken).split(".")[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))),
    );
    if (typeof claims !== "object" || claims === null) return null;
    const { sub, email, name, preferred_username } = claims as Record<string, unknown>;
    if (typeof sub !== "string" || sub === "") return null;
    return {
      userId: sub,
      email: typeof email === "string" ? email : null,
      name:
        typeof name === "string" && name !== ""
          ? name
          : typeof preferred_username === "string"
            ? preferred_username
            : null,
    };
  } catch {
    return null;
  }
}
