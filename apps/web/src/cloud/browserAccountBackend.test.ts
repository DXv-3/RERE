import { describe, expect, it, vi } from "vite-plus/test";

import { createBrowserAccountBackend } from "./browserAccountBackend";

const config = { issuer: "https://login.example.test/realms/app", clientId: "app-client" };

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function setup(fetch = vi.fn()) {
  const assign = vi.fn();
  const sessionStorage = memoryStorage();
  const backend = createBrowserAccountBackend({
    config,
    localStorage: memoryStorage(),
    sessionStorage,
    location: {
      origin: "https://app.example.test",
      pathname: "/settings/connections",
      search: "?tab=1",
      hash: "",
      assign,
    },
    openWindow: vi.fn(),
    fetch,
    now: () => 1_000_000,
  });
  return { backend, assign, fetch, sessionStorage };
}

async function startedAuthorizeUrl(
  backend: ReturnType<typeof setup>["backend"],
  assign: ReturnType<typeof vi.fn>,
  mode: "sign_in" | "sign_up",
) {
  await backend.start(mode);
  return new URL(assign.mock.calls.at(-1)?.[0] as string);
}

describe("browser account backend", () => {
  it("redirects to the sign-in or registration page with a PKCE request", async () => {
    const { backend, assign } = setup();

    const signIn = await startedAuthorizeUrl(backend, assign, "sign_in");
    expect(signIn.pathname).toBe("/realms/app/protocol/openid-connect/auth");
    expect(signIn.searchParams.get("redirect_uri")).toBe("https://app.example.test/auth/callback");
    expect(signIn.searchParams.get("code_challenge_method")).toBe("S256");

    const signUp = await startedAuthorizeUrl(backend, assign, "sign_up");
    expect(signUp.pathname).toBe("/realms/app/protocol/openid-connect/registrations");
  });

  it("exchanges the code once, signs in, and returns to the starting page", async () => {
    const accessToken = jwt({ sub: "user-9", email: "a@example.test" });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: accessToken, refresh_token: "r", expires_in: 300 }),
        ),
    );
    const { backend, assign } = setup(fetch);
    const authorizeUrl = await startedAuthorizeUrl(backend, assign, "sign_in");
    const callback = `https://app.example.test/auth/callback?code=abc&state=${authorizeUrl.searchParams.get("state")}`;

    const [first, second] = await Promise.all([
      backend.completeCallback?.(callback),
      backend.completeCallback?.(callback),
    ]);

    expect(first).toEqual({ ok: true, returnTo: "/settings/connections?tab=1" });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(backend.getSnapshot().identity?.userId).toBe("user-9");
    expect(backend.consumeFreshSignIn?.()).toBe("user-9");
    expect(backend.consumeFreshSignIn?.()).toBeNull();
  });

  it("rejects a callback whose state does not match, without calling the provider", async () => {
    const { backend, assign, fetch } = setup();
    await startedAuthorizeUrl(backend, assign, "sign_in");

    const result = await backend.completeCallback?.(
      "https://app.example.test/auth/callback?code=abc&state=forged",
    );

    expect(result?.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(backend.getSnapshot().identity).toBeNull();
  });

  it("reports a callback that has no pending sign-in", async () => {
    const { backend } = setup();
    const result = await backend.completeCallback?.(
      "https://app.example.test/auth/callback?code=abc&state=s",
    );
    expect(result?.ok).toBe(false);
  });
});
