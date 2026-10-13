import {
  accountCodeExchangeBody,
  accountEndpoints,
  buildAccountAuthorizeUrl,
  createAuthState,
  createPkcePair,
  parseAccountTokenResponse,
  readAccountCallback,
  type AccountAuthConfig,
  type AccountTokens,
} from "@t3tools/shared/accountAuth";

import {
  ACCOUNT_CALLBACK_PATH,
  type AccountAuthMode,
  type AccountCallbackResult,
  type AccountSessionBackend,
} from "./accountSession";
import { createAccountTokenManager, type AccountTokenStore } from "./accountTokenManager";

const TOKENS_KEY = "codewrench.account.tokens";
const PENDING_KEY = "codewrench.account.pending";

interface PendingSignIn {
  readonly verifier: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly returnTo: string;
}

function readJson(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function isTokens(value: unknown): value is AccountTokens {
  if (typeof value !== "object" || value === null) return false;
  const tokens = value as Record<string, unknown>;
  return typeof tokens.accessToken === "string" && typeof tokens.expiresAtEpochMs === "number";
}

function isPending(value: unknown): value is PendingSignIn {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Record<string, unknown>;
  return (
    typeof pending.verifier === "string" &&
    typeof pending.state === "string" &&
    typeof pending.redirectUri === "string" &&
    typeof pending.returnTo === "string"
  );
}

/** Storage that tolerates private windows and blocked site data. */
function localTokenStore(storage: Storage | null): AccountTokenStore {
  return {
    read: () => {
      const value = readJson(storage, TOKENS_KEY);
      return isTokens(value) ? value : null;
    },
    write: (tokens) => {
      try {
        if (tokens) storage?.setItem(TOKENS_KEY, JSON.stringify(tokens));
        else storage?.removeItem(TOKENS_KEY);
      } catch {
        // Without storage the session lasts until the page closes.
      }
    },
  };
}

/** The returnTo a callback may navigate to: a path inside this app, never another origin. */
function safeReturnTo(value: string): string {
  return value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith(ACCOUNT_CALLBACK_PATH)
    ? value
    : "/";
}

/**
 * Sign-in for a page in a normal browser: a full-page redirect to the provider's hosted pages and
 * back to `/auth/callback`, where `completeCallback` exchanges the code. Tokens live in
 * localStorage, the same exposure as the pairing credentials this app already keeps there.
 */
export function createBrowserAccountBackend(input: {
  readonly config: AccountAuthConfig;
  readonly localStorage: Storage | null;
  readonly sessionStorage: Storage | null;
  readonly location: Pick<Location, "origin" | "pathname" | "search" | "hash" | "assign">;
  readonly openWindow: (url: string) => void;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  /** Clears the environment session this browser holds when account sign-in issued it. */
  readonly afterSignOut?: () => Promise<void>;
}): AccountSessionBackend {
  const manager = createAccountTokenManager({
    config: input.config,
    store: localTokenStore(input.localStorage),
    fetch: input.fetch,
    now: input.now,
    ...(input.afterSignOut ? { afterSignOut: input.afterSignOut } : {}),
  });
  const exchanges = new Map<string, Promise<AccountCallbackResult>>();
  let freshSignIn: string | null = null;

  const complete = async (url: string): Promise<AccountCallbackResult> => {
    const pending = readJson(input.sessionStorage, PENDING_KEY);
    if (!isPending(pending)) {
      return { ok: false, message: "This sign-in link has expired. Start again from the app." };
    }
    const callback = readAccountCallback(url, pending.state);
    if (!callback.ok) {
      return {
        ok: false,
        message:
          callback.reason === "denied"
            ? "Sign-in was cancelled."
            : "This sign-in response does not match the request that started it.",
      };
    }
    try {
      input.sessionStorage?.removeItem(PENDING_KEY);
    } catch {
      // The state is single-use anyway: the provider rejects a replayed code.
    }
    try {
      const response = await input.fetch(accountEndpoints(input.config.issuer).token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: accountCodeExchangeBody({
          config: input.config,
          code: callback.code,
          verifier: pending.verifier,
          redirectUri: pending.redirectUri,
        }),
      });
      const tokens = response.ok
        ? parseAccountTokenResponse(await response.json(), input.now())
        : null;
      if (!tokens) return { ok: false, message: "The sign-in could not be completed. Try again." };
      manager.setTokens(tokens);
      freshSignIn = manager.getSnapshot().identity?.userId ?? null;
      return { ok: true, returnTo: safeReturnTo(pending.returnTo) };
    } catch {
      return { ok: false, message: "Could not reach the sign-in service. Check your connection." };
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === TOKENS_KEY || event.key === null) manager.adoptStoredTokens();
  };
  let storageListeners = 0;

  return {
    getSnapshot: manager.getSnapshot,
    // Follow sign-ins and sign-outs made in other tabs while anything is listening.
    subscribe: (listener) => {
      const unsubscribe = manager.subscribe(listener);
      if (storageListeners++ === 0) window.addEventListener("storage", onStorage);
      return () => {
        unsubscribe();
        if (--storageListeners === 0) window.removeEventListener("storage", onStorage);
      };
    },
    getToken: manager.getToken,
    start: async (mode: AccountAuthMode) => {
      const pkce = await createPkcePair();
      const state = createAuthState();
      const redirectUri = `${input.location.origin}${ACCOUNT_CALLBACK_PATH}`;
      const pending: PendingSignIn = {
        verifier: pkce.verifier,
        state,
        redirectUri,
        returnTo: `${input.location.pathname}${input.location.search}${input.location.hash}`,
      };
      try {
        input.sessionStorage?.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        throw new Error("Sign-in needs browser storage, which is blocked for this page.");
      }
      input.location.assign(
        buildAccountAuthorizeUrl({
          config: input.config,
          mode,
          redirectUri,
          challenge: pkce.challenge,
          state,
        }),
      );
    },
    signOut: () => manager.signOut(),
    openAccount: async () => input.openWindow(accountEndpoints(input.config.issuer).account),
    consumeFreshSignIn: () => {
      const userId = freshSignIn;
      freshSignIn = null;
      return userId;
    },
    // A code can be exchanged once; React effects may run twice for the same callback.
    completeCallback: (url) => {
      let exchange = exchanges.get(url);
      if (!exchange) {
        exchange = complete(url);
        exchanges.set(url, exchange);
      }
      return exchange;
    },
  };
}
