import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveAccountAuthConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires the issuer, the client id and the relay URL", () => {
    vi.stubEnv("VITE_OIDC_ISSUER", "");
    vi.stubEnv("VITE_OIDC_CLIENT_ID", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_OIDC_ISSUER", "https://login.example.test/realms/app");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_OIDC_CLIENT_ID", "app-client");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL or issuer", () => {
    vi.stubEnv("VITE_OIDC_ISSUER", "https://login.example.test/realms/app");
    vi.stubEnv("VITE_OIDC_CLIENT_ID", "app-client");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_OIDC_ISSUER", "http://login.example.test/realms/app");
    expect(hasCloudPublicConfig()).toBe(false);
  });
});

describe("resolveAccountAuthConfig", () => {
  it("returns the issuer and client id, or null when either is missing", () => {
    vi.stubEnv("VITE_OIDC_ISSUER", "https://login.example.test/realms/app");
    vi.stubEnv("VITE_OIDC_CLIENT_ID", "");
    expect(resolveAccountAuthConfig()).toBeNull();

    vi.stubEnv("VITE_OIDC_CLIENT_ID", "app-client");
    expect(resolveAccountAuthConfig()).toEqual({
      issuer: "https://login.example.test/realms/app",
      clientId: "app-client",
    });
  });
});
