import { describe, expect, it } from "vite-plus/test";

import {
  buildConnectAuthorizationUrl,
  CONNECT_OAUTH_SCOPES,
  connectLoopbackRedirectUri,
} from "./connectAuth.ts";

describe("connectAuth", () => {
  it("builds the loopback redirect URI for the callback listener", () => {
    expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  });

  it("builds a PKCE authorization URL against the issuer endpoint", () => {
    const url = new URL(
      buildConnectAuthorizationUrl({
        authorizationEndpoint:
          "https://login.example.test/realms/codewrench/protocol/openid-connect/auth",
        clientId: "codewrench-cli",
        redirectUri: connectLoopbackRedirectUri(34338),
        scopes: CONNECT_OAUTH_SCOPES,
        state: "state-1",
        challenge: "challenge-1",
      }),
    );

    expect(url.origin).toBe("https://login.example.test");
    expect(url.pathname).toBe("/realms/codewrench/protocol/openid-connect/auth");
    expect(url.searchParams.get("client_id")).toBe("codewrench-cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:34338/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
