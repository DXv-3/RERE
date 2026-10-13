import {
  accountEndpoints,
  buildAccountAuthorizeUrl,
  readAccountCallback,
  type AccountAuthConfig,
  type AccountIdentity,
  type AccountTokens,
} from "@t3tools/shared/accountAuth";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { createAccountAuthRequest } from "./accountPkce";
import {
  AccountSignInError,
  createAccountSessionController,
  type AccountTokenStorage,
} from "./accountSessionController";

const ACCOUNT_TOKENS_KEY = "t3code.cloud.account-tokens";
const ACCOUNT_CALLBACK_PATH = "account-callback";

export type AccountSignInResult =
  | { readonly status: "signed_in" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

export interface AccountSession {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly identity: AccountIdentity | null;
  /** The Keycloak access token the relay accepts, refreshed when needed. Null when signed out. */
  readonly getToken: () => Promise<string | null>;
  /** Opens the hosted sign-in form. */
  readonly signIn: () => Promise<AccountSignInResult>;
  /** Opens the hosted registration form. */
  readonly signUp: () => Promise<AccountSignInResult>;
  readonly signOut: () => Promise<void>;
  /** Opens the account page (profile, password, sessions) in the browser. */
  readonly openAccount: () => Promise<void>;
}

// Used when cloud sign-in is not configured: nothing is signed in and nothing can sign in.
const UNCONFIGURED_SESSION: AccountSession = {
  isLoaded: true,
  isSignedIn: false,
  identity: null,
  getToken: async () => null,
  signIn: async () => ({ status: "failed", message: "Sign in is not configured." }),
  signUp: async () => ({ status: "failed", message: "Sign in is not configured." }),
  signOut: async () => {},
  openAccount: async () => {},
};

const AccountSessionContext = createContext<AccountSession>(UNCONFIGURED_SESSION);

export function useAccountSession(): AccountSession {
  return useContext(AccountSessionContext);
}

const secureStorage: AccountTokenStorage = {
  read: async () => {
    const raw = await SecureStore.getItemAsync(ACCOUNT_TOKENS_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<AccountTokens>;
      return typeof value.accessToken === "string" && typeof value.expiresAtEpochMs === "number"
        ? {
            accessToken: value.accessToken,
            refreshToken: value.refreshToken ?? null,
            idToken: value.idToken ?? null,
            expiresAtEpochMs: value.expiresAtEpochMs,
          }
        : null;
    } catch {
      return null;
    }
  },
  write: (tokens) => SecureStore.setItemAsync(ACCOUNT_TOKENS_KEY, JSON.stringify(tokens)),
  clear: () => SecureStore.deleteItemAsync(ACCOUNT_TOKENS_KEY),
};

export function AccountSessionProvider(props: {
  readonly config: AccountAuthConfig;
  readonly children: ReactNode;
}) {
  const { issuer, clientId } = props.config;
  const [controller] = useState(() =>
    createAccountSessionController({
      config: { issuer, clientId },
      storage: secureStorage,
      fetch: (input, init) => fetch(input, init),
    }),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const session = useMemo<AccountSession>(() => {
    const authenticate = async (mode: "sign_in" | "sign_up"): Promise<AccountSignInResult> => {
      try {
        const request = await createAccountAuthRequest();
        const redirectUri = Linking.createURL(ACCOUNT_CALLBACK_PATH);
        const result = await WebBrowser.openAuthSessionAsync(
          buildAccountAuthorizeUrl({
            config: { issuer, clientId },
            mode,
            redirectUri,
            challenge: request.challenge,
            state: request.state,
          }),
          redirectUri,
        );
        if (result.type !== "success") return { status: "cancelled" };
        const callback = readAccountCallback(result.url, request.state);
        if (!callback.ok) {
          return callback.reason === "denied"
            ? { status: "cancelled" }
            : { status: "failed", message: "Sign in could not be verified. Try again." };
        }
        await controller.completeSignIn({
          code: callback.code,
          verifier: request.verifier,
          redirectUri,
        });
        return { status: "signed_in" };
      } catch (error) {
        return {
          status: "failed",
          message:
            error instanceof AccountSignInError
              ? error.message
              : "Could not open the sign-in page.",
        };
      }
    };
    return {
      isLoaded: snapshot.isLoaded,
      isSignedIn: snapshot.tokens !== null,
      identity: snapshot.identity,
      getToken: controller.getToken,
      signIn: () => authenticate("sign_in"),
      signUp: () => authenticate("sign_up"),
      signOut: controller.signOut,
      openAccount: async () => {
        await WebBrowser.openBrowserAsync(accountEndpoints(issuer).account);
      },
    };
  }, [clientId, controller, issuer, snapshot]);

  return (
    <AccountSessionContext.Provider value={session}>
      {props.children}
    </AccountSessionContext.Provider>
  );
}
