import type { AccountTokens } from "@t3tools/shared/accountAuth";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createAccountSessionCore,
  type AccountFormResponse,
  type AccountState,
} from "./AccountSessionCore.ts";

const config = { issuer: "https://login.example.test/realms/app", clientId: "app-client" };
const NOW = 2_000_000;

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function tokens(overrides: Partial<AccountTokens> = {}): AccountTokens {
  return {
    accessToken: jwt({ sub: "user-1", email: "ryan@example.test" }),
    refreshToken: "refresh-1",
    idToken: null,
    expiresAtEpochMs: NOW + 300_000,
    ...overrides,
  };
}

function tokenResponse(accessToken: string) {
  return {
    status: 200,
    body: { access_token: accessToken, refresh_token: "refresh-2", expires_in: 300 },
  };
}

const rejected = { status: 400, body: { error: "invalid_grant" } };

function setup(
  overrides: {
    stored?: AccountTokens | null;
    postForm?: (url: string, body: URLSearchParams) => Promise<AccountFormResponse>;
    receiveCallback?: Parameters<typeof createAccountSessionCore>[0]["receiveCallback"];
  } = {},
) {
  const saved: Array<AccountTokens | null> = [];
  const changes: AccountState[] = [];
  const postForm = vi.fn(overrides.postForm ?? (async () => ({ status: 204, body: null })));
  const core = createAccountSessionCore({
    config,
    loadTokens: async () => overrides.stored ?? null,
    saveTokens: async (next) => void saved.push(next),
    postForm,
    now: () => NOW,
    openExternal: async () => true,
    ...(overrides.receiveCallback ? { receiveCallback: overrides.receiveCallback } : {}),
    onChange: (state) => void changes.push(state),
  });
  return { core, postForm, saved, changes };
}

describe("desktop account session", () => {
  it("restores the stored session and reports who is signed in", async () => {
    const { core } = setup({ stored: tokens() });
    expect(await core.getState()).toEqual({
      identity: { userId: "user-1", email: "ryan@example.test", name: null },
    });
    expect(await core.getAccessToken()).toBe(tokens().accessToken);
  });

  it("shares one refresh between concurrent callers and persists the new tokens", async () => {
    const refreshed = jwt({ sub: "user-1" });
    const { core, postForm, saved } = setup({
      stored: tokens({ expiresAtEpochMs: NOW + 1_000 }),
      postForm: async () => tokenResponse(refreshed),
    });

    const results = await Promise.all([core.getAccessToken(), core.getAccessToken()]);

    expect(results).toEqual([refreshed, refreshed]);
    expect(postForm).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)?.refreshToken).toBe("refresh-2");
  });

  it("signs out locally when the provider rejects the refresh token", async () => {
    const { core, saved, changes } = setup({
      stored: tokens({ expiresAtEpochMs: NOW + 1_000 }),
      postForm: async () => rejected,
    });

    expect(await core.getAccessToken()).toBeNull();
    expect(saved.at(-1)).toBeNull();
    expect(changes.at(-1)).toEqual({ identity: null });
  });

  it("signs in through the loopback redirect and exchanges the code with the PKCE verifier", async () => {
    const accessToken = jwt({ sub: "user-2" });
    let authorizeUrl = "";
    const { core, postForm, changes } = setup({
      postForm: async () => tokenResponse(accessToken),
      receiveCallback: async (request) => {
        authorizeUrl = request.authorizationUrl("http://127.0.0.1:5555/callback");
        return { status: "code", code: "the-code", redirectUri: "http://127.0.0.1:5555/callback" };
      },
    });

    expect(await core.signIn("sign_up")).toEqual({ status: "signed_in" });

    const url = new URL(authorizeUrl);
    expect(url.pathname).toBe("/realms/app/protocol/openid-connect/registrations");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/callback");
    const [, body] = postForm.mock.calls[0] as unknown as [string, URLSearchParams];
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(changes.at(-1)?.identity?.userId).toBe("user-2");
  });

  it("reports cancelled and failed sign-ins without changing the session", async () => {
    const cancelled = setup({ receiveCallback: async () => ({ status: "denied" }) });
    expect(await cancelled.core.signIn("sign_in")).toEqual({ status: "cancelled" });
    expect(cancelled.changes).toEqual([]);

    const failed = setup({ receiveCallback: async () => ({ status: "failed" }) });
    expect((await failed.core.signIn("sign_in")).status).toBe("failed");

    const rejectedExchange = setup({
      postForm: async () => rejected,
      receiveCallback: async () => ({
        status: "code",
        code: "c",
        redirectUri: "http://127.0.0.1:1/callback",
      }),
    });
    expect((await rejectedExchange.core.signIn("sign_in")).status).toBe("failed");
    expect(rejectedExchange.changes).toEqual([]);
  });

  it("ends the provider session on sign out", async () => {
    const { core, postForm, saved } = setup({ stored: tokens() });

    await core.signOut();

    expect(saved.at(-1)).toBeNull();
    expect(await core.getAccessToken()).toBeNull();
    const [url, body] = postForm.mock.calls[0] as unknown as [string, URLSearchParams];
    expect(url).toBe("https://login.example.test/realms/app/protocol/openid-connect/logout");
    expect(body.get("refresh_token")).toBe("refresh-1");
  });
});
