import type { AccountIdentity } from "@t3tools/shared/accountAuth";

import type { AccountAuthMode, AccountSessionBackend } from "./accountSession";
import type { AccountSessionSnapshot } from "./accountTokenManager";

export interface DesktopAccountState {
  readonly identity: AccountIdentity | null;
}

export interface DesktopAccountSignInResult {
  readonly status: "signed_in" | "cancelled" | "failed";
  readonly message?: string;
}

/** Exposed by the desktop preload. Tokens stay in the main process; the renderer asks for them. */
export interface DesktopAccountBridge {
  readonly getState: () => Promise<DesktopAccountState>;
  readonly getAccessToken: () => Promise<string | null>;
  readonly signIn: (mode: AccountAuthMode) => Promise<DesktopAccountSignInResult>;
  readonly signOut: () => Promise<void>;
  readonly openAccount: () => Promise<void>;
  readonly onChange: (listener: (state: DesktopAccountState) => void) => () => void;
}

declare global {
  interface Window {
    readonly codewrenchAccount?: DesktopAccountBridge;
  }
}

/** The signed-in account as held by the desktop main process. */
export function createDesktopAccountBackend(
  bridge: DesktopAccountBridge,
  options?: {
    /** Clears the environment session this window holds when account sign-in issued it. */
    readonly afterSignOut?: () => Promise<void>;
  },
): AccountSessionBackend {
  let snapshot: AccountSessionSnapshot = { isLoaded: false, identity: null };
  const listeners = new Set<() => void>();
  const publish = (state: DesktopAccountState) => {
    snapshot = { isLoaded: true, identity: state.identity };
    for (const listener of listeners) listener();
  };
  let unsubscribeBridge: (() => void) | null = null;

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        unsubscribeBridge = bridge.onChange(publish);
        void bridge.getState().then(publish, () => publish({ identity: null }));
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeBridge?.();
          unsubscribeBridge = null;
        }
      };
    },
    getToken: () => bridge.getAccessToken().catch(() => null),
    start: async (mode) => {
      const result = await bridge.signIn(mode);
      if (result.status === "failed") throw new Error(result.message ?? "Sign-in failed.");
    },
    signOut: async () => {
      await bridge.signOut();
      await options?.afterSignOut?.();
    },
    openAccount: () => bridge.openAccount(),
  };
}
