import type { AccountTokens } from "@t3tools/shared/accountAuth";
import { describe, expect, it, vi } from "vite-plus/test";

import { createAccountTokenManager, type AccountTokenStore } from "./accountTokenManager";

const config = { issuer: "https://login.example.test/realms/app", clientId: "app-client" };

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

const NOW = 1_000_000;

function tokens(overrides: Partial<AccountTokens> = {}): AccountTokens {
  return {
    accessToken: jwt({ sub: "user-1", email: "ryan@example.test" }),
    refreshToken: "refresh-1",
    idToken: null,
    expiresAtEpochMs: NOW + 5 * 60_000,
    ...overrides,
  };
}

function memoryStore(initial: AccountTokens | null): AccountTokenStore & {
  current: AccountTokens | null;
} {
  const store = {
    current: initial,
    read: () => store.current,
    write: (next: AccountTokens | null) => {
      store.current = next;
    },
  };
  return store;
}

function tokenResponse(accessToken: string, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { access_token: accessToken, refresh_token: "refresh-2", expires_in: 300 }
        : { error: "invalid_grant" },
    ),
    { status },
  );
}

describe("account token manager", () => {
  it("returns the stored access token without a request while it is fresh", async () => {
    const fetch = vi.fn();
    const manager = createAccountTokenManager({
      config,
      store: memoryStore(tokens()),
      fetch,
      now: () => NOW,
    });

    expect(await manager.getToken()).toBe(tokens().accessToken);
    expect(fetch).not.toHaveBeenCalled();
    expect(manager.getSnapshot().identity).toEqual({
      userId: "user-1",
      email: "ryan@example.test",
      name: null,
    });
  });

  it("shares one refresh request between concurrent callers and keeps the new tokens", async () => {
    const refreshed = jwt({ sub: "user-1" });
    const fetch = vi.fn(async () => tokenResponse(refreshed));
    const store = memoryStore(tokens({ expiresAtEpochMs: NOW + 5_000 }));
    const manager = createAccountTokenManager({ config, store, fetch, now: () => NOW });

    const results = await Promise.all([manager.getToken(), manager.getToken(), manager.getToken()]);

    expect(results).toEqual([refreshed, refreshed, refreshed]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.example.test/realms/app/protocol/openid-connect/token");
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=refresh-1");
    expect(store.current?.refreshToken).toBe("refresh-2");
  });

  it("signs out locally when the provider rejects the refresh", async () => {
    const store = memoryStore(tokens({ expiresAtEpochMs: NOW + 5_000 }));
    const manager = createAccountTokenManager({
      config,
      store,
      fetch: async () => tokenResponse("", 400),
      now: () => NOW,
    });
    const listener = vi.fn();
    manager.subscribe(listener);

    expect(await manager.getToken()).toBeNull();
    expect(store.current).toBeNull();
    expect(manager.getSnapshot().identity).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stays signed in when the provider cannot be reached", async () => {
    const store = memoryStore(tokens({ expiresAtEpochMs: NOW + 5_000 }));
    const manager = createAccountTokenManager({
      config,
      store,
      fetch: async () => {
        throw new TypeError("offline");
      },
      now: () => NOW,
    });

    // Still valid for a few seconds, so the current token is usable.
    expect(await manager.getToken()).toBe(store.current?.accessToken);
    expect(manager.getSnapshot().identity?.userId).toBe("user-1");

    // Once it has expired there is nothing usable to hand out, but the session remains.
    const expired = createAccountTokenManager({
      config,
      store: memoryStore(tokens({ expiresAtEpochMs: NOW - 1 })),
      fetch: async () => {
        throw new TypeError("offline");
      },
      now: () => NOW,
    });
    expect(await expired.getToken()).toBeNull();
    expect(expired.getSnapshot().identity?.userId).toBe("user-1");
  });

  it("ends the provider session and clears the tokens on sign out", () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const store = memoryStore(tokens());
    const manager = createAccountTokenManager({ config, store, fetch, now: () => NOW });

    manager.signOut();

    expect(store.current).toBeNull();
    expect(manager.getSnapshot().identity).toBeNull();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://login.example.test/realms/app/protocol/openid-connect/logout");
    expect(String(init.body)).toContain("refresh_token=refresh-1");
  });

  it("refreshes a token that has not expired when asked to", async () => {
    const fresh = jwt({ sub: "user-1" });
    const fetch = vi.fn(async () => tokenResponse(fresh));
    const manager = createAccountTokenManager({
      config,
      store: memoryStore(tokens()),
      fetch,
      now: () => NOW,
    });

    expect(await manager.getToken({ forceRefresh: true })).toBe(fresh);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("waits for the environment session to be cleared before sign out finishes", async () => {
    const order: string[] = [];
    let finishLogout: () => void = () => undefined;
    const store = memoryStore(tokens());
    const manager = createAccountTokenManager({
      config,
      store,
      fetch: async () => new Response(null, { status: 204 }),
      now: () => NOW,
      afterSignOut: () =>
        new Promise<void>((resolve) => {
          order.push("logout started");
          finishLogout = () => {
            order.push("logout finished");
            resolve();
          };
        }),
    });

    const signedOut = manager.signOut().then(() => order.push("sign out resolved"));
    // Tokens are gone at once, but the call is not done until the server has answered.
    expect(store.current).toBeNull();
    await Promise.resolve();
    expect(order).toEqual(["logout started"]);
    finishLogout();
    await signedOut;
    expect(order).toEqual(["logout started", "logout finished", "sign out resolved"]);
  });

  it("reports a failed environment logout to the caller after clearing the tokens", async () => {
    const store = memoryStore(tokens());
    const manager = createAccountTokenManager({
      config,
      store,
      fetch: async () => new Response(null, { status: 204 }),
      now: () => NOW,
      afterSignOut: async () => {
        throw new Error("offline");
      },
    });

    await expect(manager.signOut()).rejects.toThrow("offline");
    expect(store.current).toBeNull();
  });
});
