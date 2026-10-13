import {
  accountCodeExchangeBody,
  accountEndpoints,
  accountRefreshBody,
  accountRefreshRejected,
  accountTokensNeedRefresh,
  buildAccountAuthorizeUrl,
  createAuthState,
  createPkcePair,
  parseAccountTokenResponse,
  readAccountIdentity,
  type AccountAuthConfig,
  type AccountIdentity,
  type AccountTokens,
} from "@t3tools/shared/accountAuth";

import { receiveAccountCallback, type AccountCallbackOutcome } from "./AccountLoopback.ts";

export interface AccountState {
  readonly identity: AccountIdentity | null;
}

export interface AccountSignInResult {
  readonly status: "signed_in" | "cancelled" | "failed";
  readonly message?: string;
}

export interface AccountFormResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface AccountSessionCoreInput {
  /** Null when this build has no account sign-in. */
  readonly config: AccountAuthConfig | null;
  readonly loadTokens: () => Promise<AccountTokens | null>;
  readonly saveTokens: (tokens: AccountTokens | null) => Promise<void>;
  /** POSTs a form to the provider. Rejects when the provider cannot be reached. */
  readonly postForm: (url: string, body: URLSearchParams) => Promise<AccountFormResponse>;
  readonly now: () => number;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly receiveCallback?: typeof receiveAccountCallback;
  readonly onChange: (state: AccountState) => void;
  /** Called once a sign-in completes, so the app can come to the front. */
  readonly onSignedIn?: () => void;
}

/**
 * The desktop account session, held in the main process: browser sign-in over a loopback redirect,
 * token refresh shared between concurrent callers, and sign-out. The renderer only ever sees the
 * identity and, on request, a current access token.
 */
export function createAccountSessionCore(input: AccountSessionCoreInput) {
  const receiveCallback = input.receiveCallback ?? receiveAccountCallback;
  let loaded: Promise<AccountTokens | null> | null = null;
  let tokens: AccountTokens | null = null;
  let refreshInFlight: Promise<AccountTokens | null> | null = null;
  let signInAbort: AbortController | null = null;

  const ensureLoaded = async () => {
    loaded ??= input.loadTokens().then(
      (stored) => (tokens = stored),
      () => (tokens = null),
    );
    await loaded;
  };

  const stateOf = (value: AccountTokens | null): AccountState => ({
    identity: value ? readAccountIdentity(value) : null,
  });

  const setTokens = async (next: AccountTokens | null) => {
    tokens = next;
    // A failed write loses persistence, not the session: it lasts until the app quits.
    await input.saveTokens(next).catch(() => undefined);
    input.onChange(stateOf(next));
  };

  const refresh = async (current: AccountTokens, config: AccountAuthConfig) => {
    if (!current.refreshToken) {
      await setTokens(null);
      return null;
    }
    try {
      const response = await input.postForm(
        accountEndpoints(config.issuer).token,
        accountRefreshBody(config, current.refreshToken),
      );
      // The provider rejected the refresh token: the session is over.
      if (accountRefreshRejected(response.body)) {
        await setTokens(null);
        return null;
      }
      if (response.status !== 200) return current;
      const parsed = parseAccountTokenResponse(response.body, input.now());
      if (!parsed) return current;
      const next: AccountTokens = {
        ...parsed,
        refreshToken: parsed.refreshToken ?? current.refreshToken,
        idToken: parsed.idToken ?? current.idToken,
      };
      await setTokens(next);
      return next;
    } catch {
      return current;
    }
  };

  const exchange = async (
    config: AccountAuthConfig,
    outcome: Extract<AccountCallbackOutcome, { status: "code" }>,
    verifier: string,
  ) => {
    const response = await input.postForm(
      accountEndpoints(config.issuer).token,
      accountCodeExchangeBody({
        config,
        code: outcome.code,
        verifier,
        redirectUri: outcome.redirectUri,
      }),
    );
    return response.status === 200 ? parseAccountTokenResponse(response.body, input.now()) : null;
  };

  return {
    getState: async (): Promise<AccountState> => {
      await ensureLoaded();
      return stateOf(tokens);
    },

    /** A valid access token, or null when signed out or the token cannot be refreshed. */
    getAccessToken: async (): Promise<string | null> => {
      await ensureLoaded();
      const current = tokens;
      if (!current || !input.config) return null;
      if (!accountTokensNeedRefresh(current, input.now())) return current.accessToken;
      const config = input.config;
      refreshInFlight ??= refresh(current, config).finally(() => {
        refreshInFlight = null;
      });
      const next = await refreshInFlight;
      return next && next.expiresAtEpochMs > input.now() ? next.accessToken : null;
    },

    /** Opens the provider in the system browser. A newer sign-in replaces one still waiting. */
    signIn: async (mode: "sign_in" | "sign_up"): Promise<AccountSignInResult> => {
      const config = input.config;
      if (!config) return { status: "failed", message: "Account sign-in is not configured." };
      await ensureLoaded();
      signInAbort?.abort();
      const abort = new AbortController();
      signInAbort = abort;
      try {
        const pkce = await createPkcePair();
        const state = createAuthState();
        const outcome = await receiveCallback({
          authorizationUrl: (redirectUri) =>
            buildAccountAuthorizeUrl({
              config,
              mode,
              redirectUri,
              challenge: pkce.challenge,
              state,
            }),
          expectedState: state,
          openBrowser: input.openExternal,
          signal: abort.signal,
        });
        if (outcome.status === "cancelled" || outcome.status === "denied") {
          return { status: "cancelled" };
        }
        if (outcome.status === "timed_out") {
          return { status: "failed", message: "Sign-in timed out. Try again." };
        }
        if (outcome.status !== "code") {
          return { status: "failed", message: "Could not open your browser to sign in." };
        }
        const next = await exchange(config, outcome, pkce.verifier);
        if (!next) return { status: "failed", message: "The sign-in could not be completed." };
        await setTokens(next);
        input.onSignedIn?.();
        return { status: "signed_in" };
      } catch {
        return { status: "failed", message: "Could not reach the sign-in service." };
      } finally {
        if (signInAbort === abort) signInAbort = null;
      }
    },

    /** Forgets the tokens here and ends the provider session in the background. */
    signOut: async (): Promise<void> => {
      await ensureLoaded();
      signInAbort?.abort();
      const current = tokens;
      await setTokens(null);
      const config = input.config;
      if (!current?.refreshToken || !config) return;
      void input
        .postForm(
          accountEndpoints(config.issuer).endSession,
          new URLSearchParams({ client_id: config.clientId, refresh_token: current.refreshToken }),
        )
        .catch(() => undefined);
    },

    /** The provider's profile page, in the system browser. */
    openAccount: async (): Promise<void> => {
      if (input.config) await input.openExternal(accountEndpoints(input.config.issuer).account);
    },
  };
}

export type AccountSessionCore = ReturnType<typeof createAccountSessionCore>;
