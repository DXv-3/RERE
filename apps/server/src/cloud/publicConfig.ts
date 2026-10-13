import { accountEndpoints } from "@t3tools/shared/accountAuth";
import { connectLoopbackRedirectUri, CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_OIDC_ISSUER__: string | undefined;
declare const __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeOidcIssuer = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_ISSUER__ === "undefined" ? undefined : __T3CODE_BUILD_OIDC_ISSUER__,
);
const buildTimeOidcCliClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__,
);
const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

/**
 * Endpoints and client identity for the CLI's OpenID Connect sign-in. The browser leg opens the
 * issuer's authorization endpoint directly (authorization code + PKCE S256, loopback redirect);
 * headless hosts use the device authorization endpoint instead. The server never verifies account
 * tokens itself, it forwards the access token to the relay.
 */
export interface CloudCliOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

function validateOidcIssuer(value: string): Effect.Effect<string, Config.ConfigError> {
  const issuer = normalizeSecureUrl(value);
  return issuer === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "OIDC issuer must be an absolute HTTPS URL.",
            }),
          ),
        ),
      )
    : Effect.succeed(issuer.replace(/\/+$/, ""));
}

export function makeCloudCliOAuthConfig({
  oidcIssuerFallback = buildTimeOidcIssuer,
  oidcCliClientIdFallback = buildTimeOidcCliClientId,
}: {
  readonly oidcIssuerFallback?: string;
  readonly oidcCliClientIdFallback?: string;
} = {}) {
  return Config.all({
    issuer: makePublicValueConfig("T3CODE_OIDC_ISSUER", oidcIssuerFallback),
    clientId: makePublicValueConfig("T3CODE_OIDC_CLI_CLIENT_ID", oidcCliClientIdFallback),
  }).pipe(
    Config.mapEffect(({ issuer, clientId }) =>
      validateOidcIssuer(issuer).pipe(
        Effect.map((normalizedIssuer) => {
          const endpoints = accountEndpoints(normalizedIssuer);
          return {
            authorizationEndpoint: endpoints.authorization,
            tokenEndpoint: endpoints.token,
            deviceAuthorizationEndpoint: endpoints.deviceAuthorization,
            clientId,
            loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
            redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
            scopes: CLOUD_CLI_OAUTH_SCOPES,
          } satisfies CloudCliOAuthConfig;
        }),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeSecureRelayUrl(process.env.T3CODE_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
  (process.env.T3CODE_OIDC_ISSUER?.trim() || buildTimeOidcIssuer) &&
  (process.env.T3CODE_OIDC_CLI_CLIENT_ID?.trim() || buildTimeOidcCliClientId),
);
