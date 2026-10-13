import type { AccountTokens } from "@t3tools/shared/accountAuth";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AccountSignInError,
  createAccountSessionController,
  type AccountTokenStorage,
} from "./accountSessionController";

const config = { issuer: "https://login.example.test/realms/codewrench", clientId: "app" };
const TOKEN_URL = "https://login.example.test/realms/codewrench/protocol/openid-connect/token";

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

function tokens(overrides: Partial<AccountTokens> = {}): AccountTokens {
  return {
    accessToken: jwt({ sub: "user-1", email: "a@example.test" }),
    refreshToken: "refresh-1",
    idToken: null,
    expiresAtEpochMs: 1_000_000 + 10 * 60_000,
    ...overrides,
  };
}

function memoryStorage(initial: AccountTokens | null): AccountTokenStorage & {
  value: AccountTokens | null;
} {
  const storage = {
    value: initial,
    read: async () => storage.value,
    write: async (next: AccountTokens) => {
      storage.value = next;
    },
    clear: async () => {
      storage.value = null;
    },
  };
  return storage;
}

function tokenResponse(accessToken: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: 300, ...extra }), {
    status: 200,
  });
}

function setup(initial: AccountTokens | null, fetchImpl: typeof fetch) {
  const storage = memoryStorage(initial);
  const controller = createAccountSessionController({
    config,
    storage,
    fetch: fetchImpl,
    now: () => 1_000_000,
  });
  return { controller, storage };
}

describe("accountSessionController", () => {
  it("loads the stored session and exposes who is signed in", async () => {
    const { controller } = setup(tokens(), vi.fn());
    await controller.whenLoaded();
    expect(controller.getSnapshot()).toMatchObject({
      isLoaded: true,
      identity: { userId: "user-1", email: "a@example.test" },
    });
  });

  it("returns the stored access token without a network call while it is fresh", async () => {
    const fetchMock = vi.fn();
    const { controller } = setup(tokens(), fetchMock);
    expect(await controller.getToken()).toBe(tokens().accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when signed out", async () => {
    const { controller } = setup(null, vi.fn());
    expect(await controller.getToken()).toBeNull();
  });

  it("shares one refresh between concurrent callers and keeps the old refresh token if none is returned", async () => {
    const fetchMock = vi.fn(async () => tokenResponse("new-access"));
    const { controller, storage } = setup(
      tokens({ expiresAtEpochMs: 1_000_000 + 5_000 }),
      fetchMock as unknown as typeof fetch,
    );
    const results = await Promise.all([
      controller.getToken(),
      controller.getToken(),
      controller.getToken(),
    ]);
    expect(results).toEqual(["new-access", "new-access", "new-access"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.value?.refreshToken).toBe("refresh-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(String(init.body)).toContain("grant_type=refresh_token");
  });

  it("signs out locally when the server rejects the refresh token", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    const { controller, storage } = setup(
      tokens({ expiresAtEpochMs: 1_000_000 + 5_000 }),
      fetchMock as unknown as typeof fetch,
    );
    expect(await controller.getToken()).toBeNull();
    expect(controller.getSnapshot().tokens).toBeNull();
    expect(storage.value).toBeNull();
  });

  it("stays signed in when something in front of the server refuses the refresh", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>challenge</html>", { status: 403 }));
    const current = tokens({ expiresAtEpochMs: 1_000_000 + 5_000 });
    const { controller, storage } = setup(current, fetchMock as unknown as typeof fetch);
    expect(await controller.getToken()).toBe(current.accessToken);
    expect(controller.getSnapshot().tokens).not.toBeNull();
    expect(storage.value).not.toBeNull();
  });

  it("keeps the session through a network failure while the token is still valid", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    const current = tokens({ expiresAtEpochMs: 1_000_000 + 5_000 });
    const { controller } = setup(current, fetchMock as unknown as typeof fetch);
    expect(await controller.getToken()).toBe(current.accessToken);
    expect(controller.getSnapshot().tokens).not.toBeNull();
  });

  it("does not let a refresh that began before sign-out restore the session", async () => {
    let finishRefresh: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url === TOKEN_URL) finishRefresh = resolve;
          else resolve(new Response("", { status: 204 }));
        }),
    );
    const { controller, storage } = setup(
      tokens({ expiresAtEpochMs: 1_000_000 + 5_000 }),
      fetchMock as unknown as typeof fetch,
    );
    const pending = controller.getToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await controller.signOut();
    finishRefresh(tokenResponse("late-access"));
    expect(await pending).toBeNull();
    expect(controller.getSnapshot().tokens).toBeNull();
    expect(storage.value).toBeNull();
  });

  it("exchanges an authorization code and stores the session", async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse(jwt({ sub: "user-2", email: "b@example.test" }), { refresh_token: "r" }),
    );
    const { controller, storage } = setup(null, fetchMock as unknown as typeof fetch);
    await controller.completeSignIn({ code: "c", verifier: "v", redirectUri: "app://cb" });
    expect(controller.getSnapshot().identity?.userId).toBe("user-2");
    expect(storage.value?.refreshToken).toBe("r");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("code_verifier=v");
  });

  it("reports a failed code exchange without creating a session", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 400 }));
    const { controller } = setup(null, fetchMock as unknown as typeof fetch);
    await expect(
      controller.completeSignIn({ code: "c", verifier: "v", redirectUri: "app://cb" }),
    ).rejects.toBeInstanceOf(AccountSignInError);
    expect(controller.getSnapshot().tokens).toBeNull();
  });

  it("signs out locally first and ends the server session", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 204 }));
    const { controller, storage } = setup(tokens(), fetchMock as unknown as typeof fetch);
    await controller.whenLoaded();
    await controller.signOut();
    expect(controller.getSnapshot().tokens).toBeNull();
    expect(storage.value).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/protocol/openid-connect/logout");
    expect(String(init.body)).toContain("refresh_token=refresh-1");
  });
});
