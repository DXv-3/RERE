import {
  accountCodeExchangeBody,
  accountEndpoints,
  accountRefreshBody,
  accountRefreshRejected,
  accountTokensNeedRefresh,
  parseAccountTokenResponse,
  readAccountIdentity,
  type AccountAuthConfig,
  type AccountIdentity,
  type AccountTokens,
} from "@t3tools/shared/accountAuth";

export interface AccountTokenStorage {
  readonly read: () => Promise<AccountTokens | null>;
  readonly write: (tokens: AccountTokens) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface AccountSessionSnapshot {
  readonly isLoaded: boolean;
  readonly tokens: AccountTokens | null;
  readonly identity: AccountIdentity | null;
}

export class AccountSignInError extends Error {
  override readonly name = "AccountSignInError";
}

const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" } as const;

/**
 * The signed-in account's tokens: loading them, refreshing them (one refresh at a time, however
 * many callers ask), and dropping them. Platform pieces (storage, fetch, clock) are injected so
 * the rules stay testable without a device.
 */
export function createAccountSessionController(options: {
  readonly config: AccountAuthConfig;
  readonly storage: AccountTokenStorage;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}) {
  const { config, storage } = options;
  const now = options.now ?? Date.now;
  const endpoints = accountEndpoints(config.issuer);
  const listeners = new Set<() => void>();
  let snapshot: AccountSessionSnapshot = { isLoaded: false, tokens: null, identity: null };
  let refreshInFlight: Promise<AccountTokens | null> | null = null;
  // Bumped whenever the session is replaced or dropped, so a refresh that started for an older
  // session cannot write its tokens back.
  let generation = 0;

  const publish = (tokens: AccountTokens | null) => {
    snapshot = {
      isLoaded: true,
      tokens,
      identity: tokens ? readAccountIdentity(tokens) : null,
    };
    for (const listener of listeners) listener();
  };

  const persist = async (tokens: AccountTokens) => {
    try {
      await storage.write(tokens);
    } catch {
      // The session still works in memory; the next launch asks the user to sign in again.
    }
  };

  const loadPromise = (async () => {
    let stored: AccountTokens | null = null;
    try {
      stored = await storage.read();
    } catch {
      // Unreadable storage is the same as no session.
    }
    publish(stored);
  })();

  const dropSession = async () => {
    generation += 1;
    publish(null);
    try {
      await storage.clear();
    } catch {
      // Nothing more to do; the in-memory session is already gone.
    }
  };

  const stillValid = (tokens: AccountTokens) => (tokens.expiresAtEpochMs > now() ? tokens : null);

  const runRefresh = async (): Promise<AccountTokens | null> => {
    const current = snapshot.tokens;
    const startedGeneration = generation;
    if (!current?.refreshToken) {
      await dropSession();
      return null;
    }
    let response: Response;
    try {
      response = await options.fetch(endpoints.token, {
        method: "POST",
        headers: FORM_HEADERS,
        body: accountRefreshBody(config, current.refreshToken).toString(),
      });
    } catch {
      // Offline or unreachable: keep the session and use the token while it is still valid.
      return stillValid(current);
    }
    const body: unknown = await response.json().catch(() => null);
    if (accountRefreshRejected(body)) {
      // The server rejected the refresh token (expired, revoked, session ended).
      if (startedGeneration === generation) await dropSession();
      return null;
    }
    const parsed = response.ok ? parseAccountTokenResponse(body, now()) : null;
    if (!parsed) return stillValid(current);
    const next: AccountTokens = {
      ...parsed,
      refreshToken: parsed.refreshToken ?? current.refreshToken,
      idToken: parsed.idToken ?? current.idToken,
    };
    if (startedGeneration !== generation) return null;
    publish(next);
    await persist(next);
    return next;
  };

  const refresh = (): Promise<AccountTokens | null> => {
    refreshInFlight ??= runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    /** Resolves once the stored session has been read. */
    whenLoaded: () => loadPromise,

    /** A usable access token, refreshed first when it is close to expiring. Null when signed out. */
    async getToken(): Promise<string | null> {
      await loadPromise;
      const tokens = snapshot.tokens;
      if (!tokens) return null;
      if (!accountTokensNeedRefresh(tokens, now())) return tokens.accessToken;
      return (await refresh())?.accessToken ?? null;
    },

    /** Trades the authorization code from the browser hand-off for a session. */
    async completeSignIn(input: {
      readonly code: string;
      readonly verifier: string;
      readonly redirectUri: string;
    }): Promise<void> {
      let response: Response;
      try {
        response = await options.fetch(endpoints.token, {
          method: "POST",
          headers: FORM_HEADERS,
          body: accountCodeExchangeBody({ config, ...input }).toString(),
        });
      } catch {
        throw new AccountSignInError("Could not reach the sign-in server.");
      }
      const tokens = response.ok
        ? parseAccountTokenResponse(await response.json().catch(() => null), now())
        : null;
      if (!tokens) throw new AccountSignInError("Sign in could not be completed.");
      generation += 1;
      publish(tokens);
      await persist(tokens);
    },

    /** Drops the session on this device and ends it on the server, best effort. */
    async signOut(): Promise<void> {
      const refreshToken = snapshot.tokens?.refreshToken ?? null;
      await dropSession();
      if (!refreshToken) return;
      try {
        // Ends the server-side session, so the browser's single sign-on cookie stops working too.
        await options.fetch(endpoints.endSession, {
          method: "POST",
          headers: FORM_HEADERS,
          body: new URLSearchParams({
            client_id: config.clientId,
            refresh_token: refreshToken,
          }).toString(),
        });
      } catch {
        // Already signed out locally.
      }
    },
  };
}

export type AccountSessionController = ReturnType<typeof createAccountSessionController>;
