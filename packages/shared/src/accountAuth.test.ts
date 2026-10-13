import { describe, expect, it } from "vite-plus/test";

import {
  accountCodeExchangeBody,
  accountRefreshRejected,
  accountTokensNeedRefresh,
  buildAccountAuthorizeUrl,
  createPkcePair,
  parseAccountTokenResponse,
  readAccountCallback,
  readAccountIdentity,
} from "./accountAuth.ts";

const config = { issuer: "https://login.example.test/realms/codewrench/", clientId: "app" };
const jwt = (claims: object) =>
  `h.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

describe("account sign-in", () => {
  it("sends sign-up to the registration form and sign-in to the login form", async () => {
    const pkce = await createPkcePair();
    const build = (mode: "sign_in" | "sign_up") =>
      new URL(
        buildAccountAuthorizeUrl({
          config,
          mode,
          redirectUri: "codewrench://auth",
          challenge: pkce.challenge,
          state: "s1",
        }),
      );
    expect(build("sign_in").pathname).toBe("/realms/codewrench/protocol/openid-connect/auth");
    const signUp = build("sign_up");
    expect(signUp.pathname).toBe("/realms/codewrench/protocol/openid-connect/registrations");
    expect(Object.fromEntries(signUp.searchParams)).toMatchObject({
      client_id: "app",
      response_type: "code",
      redirect_uri: "codewrench://auth",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    expect(signUp.searchParams.get("scope")).toContain("offline_access");
  });

  it("derives the challenge from the verifier with SHA-256", async () => {
    const { verifier, challenge } = await createPkcePair();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("only accepts a callback that carries the state it sent", () => {
    expect(readAccountCallback("codewrench://auth?code=abc&state=s1", "s1")).toEqual({
      ok: true,
      code: "abc",
    });
    expect(readAccountCallback("codewrench://auth#code=abc&state=s1", "s1")).toEqual({
      ok: true,
      code: "abc",
    });
    expect(readAccountCallback("codewrench://auth?code=abc&state=other", "s1")).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
    expect(readAccountCallback("codewrench://auth?error=access_denied&state=s1", "s1")).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("exchanges the code with the verifier and no secret", () => {
    expect(
      Object.fromEntries(
        accountCodeExchangeBody({
          config,
          code: "abc",
          verifier: "v",
          redirectUri: "codewrench://auth",
        }),
      ),
    ).toEqual({
      grant_type: "authorization_code",
      client_id: "app",
      code: "abc",
      code_verifier: "v",
      redirect_uri: "codewrench://auth",
    });
  });

  it("reads tokens and who they belong to", () => {
    const tokens = parseAccountTokenResponse(
      {
        access_token: jwt({ sub: "user-1" }),
        refresh_token: "r",
        id_token: jwt({ sub: "user-1", email: "a@example.test", preferred_username: "a" }),
        expires_in: 300,
      },
      1_000,
    );
    expect(tokens?.expiresAtEpochMs).toBe(301_000);
    expect(readAccountIdentity(tokens!)).toEqual({
      userId: "user-1",
      email: "a@example.test",
      name: "a",
    });
    expect(accountTokensNeedRefresh(tokens!, 200_000)).toBe(false);
    expect(accountTokensNeedRefresh(tokens!, 280_000)).toBe(true);
    expect(parseAccountTokenResponse({ error: "invalid_grant" }, 0)).toBeNull();
  });

  it("ends a session only when the issuer says the refresh token is dead", () => {
    expect(accountRefreshRejected({ error: "invalid_grant" })).toBe(true);
    // A proxy's challenge page or rate limit, an outage, or a client misconfiguration is not the
    // user's session ending.
    expect(accountRefreshRejected(null)).toBe(false);
    expect(accountRefreshRejected({})).toBe(false);
    expect(accountRefreshRejected({ error: "temporarily_unavailable" })).toBe(false);
  });
});
