import type { AccountIdentity } from "@t3tools/shared/accountAuth";

import type { AccountSessionSnapshot, AccountTokenOptions } from "./accountTokenManager";

/** Where the provider sends the browser back to after a sign-in. */
export const ACCOUNT_CALLBACK_PATH = "/auth/callback";

export type AccountAuthMode = "sign_in" | "sign_up";

export type AccountCallbackResult =
  | { readonly ok: true; readonly returnTo: string }
  | { readonly ok: false; readonly message: string };

/** One way of holding the signed-in account: the browser redirect flow or the desktop bridge. */
export interface AccountSessionBackend {
  readonly getSnapshot: () => AccountSessionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getToken: (options?: AccountTokenOptions) => Promise<string | null>;
  readonly start: (mode: AccountAuthMode) => Promise<void>;
  /** Also ends this browser's environment session when account sign-in issued it. */
  readonly signOut: () => Promise<void>;
  readonly openAccount: () => Promise<void>;
  /** Browser only: finishes a sign-in from the provider's redirect back to this app. */
  readonly completeCallback?: (url: string) => Promise<AccountCallbackResult>;
  /**
   * Browser only: the account that just signed in through `completeCallback`, once. The redirect
   * reloads the app, so listeners that watch for a sign-in cannot observe the transition.
   */
  readonly consumeFreshSignIn?: () => string | null;
}

export interface AccountSession {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly identity: AccountIdentity | null;
  readonly getToken: (options?: AccountTokenOptions) => Promise<string | null>;
  readonly signIn: () => Promise<void>;
  readonly signUp: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly openAccount: () => Promise<void>;
  readonly completeCallback: ((url: string) => Promise<AccountCallbackResult>) | null;
  readonly consumeFreshSignIn: () => string | null;
}
