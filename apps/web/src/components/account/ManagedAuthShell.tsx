import type { ReactNode } from "react";

import { AccountSessionProvider } from "../../cloud/AccountSessionProvider";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";

/**
 * Account sign-in boundary around the app, loaded lazily from the entry so a build without
 * account sign-in never downloads it.
 *
 * It wraps the app root, so it needs the app's atom registry itself: the account dialog and the
 * relay session sync render here, outside `AppRoot`, and read the signed-in relay session that the
 * rest of the app writes to that registry. Without it the dialog waits forever for an account.
 */
export default function ManagedAuthShell({ children }: { readonly children: ReactNode }) {
  return (
    <AppAtomRegistryProvider>
      <AccountSessionProvider>
        <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
      </AccountSessionProvider>
    </AppAtomRegistryProvider>
  );
}
