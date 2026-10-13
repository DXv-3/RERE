// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.T3CODE_OIDC_ISSUER).toBeUndefined();
    expect(env.T3CODE_OIDC_CLIENT_ID).toBeUndefined();
    expect(env.T3CODE_OIDC_CLI_CLIENT_ID).toBeUndefined();
    expect(env.VITE_OIDC_ISSUER).toBeUndefined();
    expect(env.EXPO_PUBLIC_OIDC_ISSUER).toBeUndefined();
    expect(env.VITE_OIDC_CLIENT_ID).toBeUndefined();
    expect(env.EXPO_PUBLIC_OIDC_CLIENT_ID).toBeUndefined();
    expect(env.T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("uses the committed defaults when nothing else is configured", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.defaults"),
      "T3CODE_OIDC_ISSUER=https://default.example.test/realms/a\nT3CODE_OIDC_CLIENT_ID=client_default\nT3CODE_RELAY_URL=https://default.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      VITE_OIDC_ISSUER: "https://default.example.test/realms/a",
      VITE_OIDC_CLIENT_ID: "client_default",
      VITE_T3CODE_RELAY_URL: "https://default.example.test",
    });

    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_RELAY_URL=https://root.example.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).VITE_T3CODE_RELAY_URL).toBe(
      "https://root.example.test",
    );

    const off = loadRepoEnv({ baseEnv: { T3CODE_CLOUD: "off" }, repoRoot });
    expect(off.VITE_OIDC_ISSUER).toBeUndefined();
    expect(off.VITE_T3CODE_RELAY_URL).toBe("https://root.example.test");
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_OIDC_ISSUER=https://root.example.test/realms/a\nT3CODE_OIDC_CLIENT_ID=client_root\nT3CODE_OIDC_CLI_CLIENT_ID=cli_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_OIDC_ISSUER=https://local.example.test/realms/a\nT3CODE_OIDC_CLIENT_ID=client_local\nT3CODE_OIDC_CLI_CLIENT_ID=cli_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_OIDC_ISSUER: "https://ci.example.test/realms/a",
          T3CODE_OIDC_CLIENT_ID: "client_ci",
          T3CODE_OIDC_CLI_CLIENT_ID: "cli_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_OIDC_ISSUER: "https://ci.example.test/realms/a",
      VITE_OIDC_ISSUER: "https://ci.example.test/realms/a",
      EXPO_PUBLIC_OIDC_ISSUER: "https://ci.example.test/realms/a",
      T3CODE_OIDC_CLIENT_ID: "client_ci",
      VITE_OIDC_CLIENT_ID: "client_ci",
      EXPO_PUBLIC_OIDC_CLIENT_ID: "client_ci",
      T3CODE_OIDC_CLI_CLIENT_ID: "cli_ci",
      VITE_OIDC_CLI_CLIENT_ID: "cli_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_OIDC_ISSUER: "https://legacy.example.test/realms/a",
        VITE_OIDC_CLIENT_ID: "client_legacy",
        T3CODE_OIDC_CLI_CLIENT_ID: "cli_canonical",
        VITE_T3CODE_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      oidcIssuer: "https://legacy.example.test/realms/a",
      oidcClientId: "client_legacy",
      oidcCliClientId: "cli_canonical",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_URL: "https://relay.example.test",
          T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      T3CODE_RELAY_URL: "https://relay.example.test",
      VITE_T3CODE_RELAY_URL: "https://relay.example.test",
      T3CODE_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
