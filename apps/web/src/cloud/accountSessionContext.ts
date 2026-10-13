import { createContext, useContext } from "react";

import type { AccountSession } from "./accountSession";

const SIGNED_OUT_SESSION: AccountSession = {
  isLoaded: true,
  isSignedIn: false,
  identity: null,
  getToken: async () => null,
  signIn: async () => undefined,
  signUp: async () => undefined,
  signOut: async () => undefined,
  openAccount: async () => undefined,
  completeCallback: null,
  consumeFreshSignIn: () => null,
};

export const AccountSessionContext = createContext<AccountSession>(SIGNED_OUT_SESSION);

/** The signed-in account. Outside a provider (no account sign-in configured) it is signed out. */
export function useAccountSession(): AccountSession {
  return useContext(AccountSessionContext);
}
