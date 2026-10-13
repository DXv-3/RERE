import {
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

export interface AccountSessionSnapshot {
  readonly isLoaded: boolean;
  readonly identity: AccountIdentity | null;
}

export interface AccountTokenOptions {
  /** Refresh even when the stored access token has not expired, e.g. after a server refused it. */
  readonly forceRefresh?: boolean;
}

export interface AccountTokenStore {
  readonly read: () => AccountTokens | null;
  readonly write: (tokens: AccountTokens | null) => void;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Holds the signed-in account's tokens: persists them, hands out a fresh access token, and lets
 * concurrent callers share one refresh request. A refresh the server rejects (revoked or expired
 * session) signs the user out locally. A refresh that could not reach the server leaves them
 * signed in, so a dropped connection does not end the session.
 */
export function createAccountTokenManager(input: {
  readonly config: AccountAuthConfig;
  readonly store: AccountTokenStore;
  readonly fetch: Fetch;
  readonly now: () => number;
  /** Runs after the local tokens are forgotten, for work that must finish before sign-out does. */
  readonly afterSignOut?: () => Promise<void>;
}) {
  const listeners = new Set<() => void>();
  let tokens = input.store.read();
  let refreshInFlight: Promise<AccountTokens | null> | null = null;

  const snapshotFor = (value: AccountTokens | null): AccountSessionSnapshot => ({
    isLoaded: true,
    identity: value ? readAccountIdentity(value) : null,
  });
  let snapshot = snapshotFor(tokens);

  const publish = (next: AccountTokens | null) => {
    tokens = next;
    const identity = next ? readAccountIdentity(next) : null;
    if (
      identity?.userId !== snapshot.identity?.userId ||
      identity?.email !== snapshot.identity?.email
    ) {
      snapshot = { isLoaded: true, identity };
      for (const listener of listeners) listener();
    }
  };

  const setTokens = (next: AccountTokens | null) => {
    input.store.write(next);
    publish(next);
  };

  const refresh = async (current: AccountTokens): Promise<AccountTokens | null> => {
    if (!current.refreshToken) {
      setTokens(null);
      return null;
    }
    try {
      const response = await input.fetch(accountEndpoints(input.config.issuer).token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: accountRefreshBody(input.config, current.refreshToken),
      });
      const body: unknown = await response.json().catch(() => null);
      if (accountRefreshRejected(body)) {
        setTokens(null);
        return null;
      }
      if (!response.ok) return current;
      const parsed = parseAccountTokenResponse(body, input.now());
      if (!parsed) return current;
      const next: AccountTokens = {
        ...parsed,
        refreshToken: parsed.refreshToken ?? current.refreshToken,
        idToken: parsed.idToken ?? current.idToken,
      };
      setTokens(next);
      return next;
    } catch {
      return current;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTokens,
    /** Another tab changed the stored tokens. */
    adoptStoredTokens: () => publish(input.store.read()),
    getTokens: () => tokens,
    /** A valid access token, or null when signed out or the token cannot be refreshed. */
    getToken: async (options?: AccountTokenOptions): Promise<string | null> => {
      const current = tokens;
      if (!current) return null;
      if (!options?.forceRefresh && !accountTokensNeedRefresh(current, input.now())) {
        return current.accessToken;
      }
      refreshInFlight ??= refresh(current).finally(() => {
        refreshInFlight = null;
      });
      const next = await refreshInFlight;
      if (!next) return null;
      return next.expiresAtEpochMs > input.now() ? next.accessToken : null;
    },
    /**
     * Forgets the tokens here and ends the provider session in the background, then waits for
     * `afterSignOut` (clearing the environment session) so a caller can rely on both being done.
     */
    signOut: async (): Promise<void> => {
      const current = tokens;
      setTokens(null);
      if (current?.refreshToken) {
        void input
          .fetch(accountEndpoints(input.config.issuer).endSession, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: input.config.clientId,
              refresh_token: current.refreshToken,
            }),
          })
          .catch(() => undefined);
      }
      await input.afterSignOut?.();
    },
  };
}

export type AccountTokenManager = ReturnType<typeof createAccountTokenManager>;
