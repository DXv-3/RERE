import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import { AccountDialog } from "../components/account/AccountDialog";
import type { AccountSession, AccountSessionBackend } from "./accountSession";
import { AccountSessionContext } from "./accountSessionContext";
import { logoutPrimaryAccountSession } from "../environments/primary";
import { createBrowserAccountBackend } from "./browserAccountBackend";
import { createDesktopAccountBackend } from "./desktopAccountBackend";
import { resolveAccountAuthConfig } from "./publicConfig";

function safeStorage(read: () => Storage): Storage | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Signing out of the account also ends this page's environment session, but only when account
 * sign-in opened it. The page then returns to the first screen, which asks for a sign-in again.
 */
async function endEnvironmentSession(): Promise<void> {
  if (await logoutPrimaryAccountSession()) window.location.assign("/");
}

function createBackend(): AccountSessionBackend | null {
  if (window.codewrenchAccount) {
    return createDesktopAccountBackend(window.codewrenchAccount, {
      afterSignOut: endEnvironmentSession,
    });
  }
  const config = resolveAccountAuthConfig();
  if (!config) return null;
  return createBrowserAccountBackend({
    config,
    localStorage: safeStorage(() => window.localStorage),
    sessionStorage: safeStorage(() => window.sessionStorage),
    location: window.location,
    openWindow: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
    fetch: (url, init) => window.fetch(url, init),
    now: () => Date.now(),
    afterSignOut: endEnvironmentSession,
  });
}

function ConfiguredAccountSessionProvider({
  backend,
  children,
}: {
  readonly backend: AccountSessionBackend;
  readonly children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(backend.subscribe, backend.getSnapshot);
  const session = useMemo<AccountSession>(
    () => ({
      isLoaded: snapshot.isLoaded,
      isSignedIn: snapshot.identity !== null,
      identity: snapshot.identity,
      getToken: backend.getToken,
      signIn: () => backend.start("sign_in"),
      signUp: () => backend.start("sign_up"),
      signOut: backend.signOut,
      openAccount: backend.openAccount,
      completeCallback: backend.completeCallback ?? null,
      consumeFreshSignIn: backend.consumeFreshSignIn ?? (() => null),
    }),
    [backend, snapshot],
  );
  return (
    <AccountSessionContext.Provider value={session}>
      {children}
      <AccountDialog />
    </AccountSessionContext.Provider>
  );
}

export function AccountSessionProvider({ children }: { readonly children: ReactNode }) {
  const backend = useMemo(() => createBackend(), []);
  if (!backend) return children;
  return (
    <ConfiguredAccountSessionProvider backend={backend}>
      {children}
    </ConfiguredAccountSessionProvider>
  );
}
