const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";

/**
 * Origin of the hosted web app. Web builds use it to decide whether they are the hosted
 * deployment, and the server prints links against it.
 */
export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

/**
 * Scopes the CLI requests, both in the browser authorization request and in the device
 * authorization request. `offline_access` asks the issuer for the refresh token the CLI relies on.
 */
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * Redirect URI for the CLI's local callback listener. The CLI client on the OpenID Connect
 * issuer must allow loopback redirects (`http://127.0.0.1/*`).
 */
export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
}

/** The authorization-code + PKCE (S256) URL the CLI opens in the user's browser. */
export function buildConnectAuthorizationUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
