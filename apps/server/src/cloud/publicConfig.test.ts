import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("uses the statically injected relay URL when no runtime override exists", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test///").pipe(
      provideEnv({}),
    );

    assert.equal(relayUrl, "https://embedded.example.test");
  }),
);

it.effect("prefers a runtime relay URL override over the statically injected value", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test").pipe(
      provideEnv({ T3CODE_RELAY_URL: "https://runtime.example.test///" }),
    );

    assert.equal(relayUrl, "https://runtime.example.test");
  }),
);

it.effect("requires a relay URL when the server bundle has no injected value", () =>
  makeRelayUrlConfig("").pipe(provideEnv({}), Effect.flip),
);

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects an injected relay URL with a non-origin path", () =>
  makeRelayUrlConfig("https://embedded.example.test/path").pipe(provideEnv({}), Effect.flip),
);

const ISSUER = "https://login.example.test/realms/codewrench";
const OIDC_BASE = `${ISSUER}/protocol/openid-connect`;

it.effect("derives OpenID Connect endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      oidcIssuerFallback: `${ISSUER}/`,
      oidcCliClientIdFallback: "codewrench-cli",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      authorizationEndpoint: `${OIDC_BASE}/auth`,
      tokenEndpoint: `${OIDC_BASE}/token`,
      deviceAuthorizationEndpoint: `${OIDC_BASE}/auth/device`,
      clientId: "codewrench-cli",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

it.effect("prefers runtime OpenID Connect overrides over statically injected values", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      oidcIssuerFallback: "https://embedded.example.test/realms/a",
      oidcCliClientIdFallback: "embedded-client",
    }).pipe(
      provideEnv({
        T3CODE_OIDC_ISSUER: "https://runtime.example.test/realms/b",
        T3CODE_OIDC_CLI_CLIENT_ID: "runtime-client",
      }),
    );

    assert.equal(
      config.tokenEndpoint,
      "https://runtime.example.test/realms/b/protocol/openid-connect/token",
    );
    assert.equal(config.clientId, "runtime-client");
  }),
);

it.effect("requires OpenID Connect config when the server bundle has no injected values", () =>
  makeCloudCliOAuthConfig({
    oidcIssuerFallback: "",
    oidcCliClientIdFallback: "",
  }).pipe(provideEnv({}), Effect.flip),
);

it.effect("rejects a malformed or insecure OIDC issuer", () =>
  Effect.gen(function* () {
    for (const issuer of ["login.example.test", "http://login.example.test/realms/x"]) {
      const result = yield* makeCloudCliOAuthConfig({
        oidcIssuerFallback: issuer,
        oidcCliClientIdFallback: "codewrench-cli",
      }).pipe(provideEnv({}), Effect.result);
      assert.isTrue(Result.isFailure(result), issuer);
    }
  }),
);

it("resolves relay client tracing from runtime config with build-time fallback", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };

  assert.deepEqual(resolveRelayClientTracingConfig({}, fallback), fallback);
  assert.deepEqual(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    {
      tracesUrl: "https://runtime.example.test/v1/traces",
      tracesDataset: "runtime-dataset",
      tracesToken: "runtime-token",
    },
  );
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "http://insecure.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
