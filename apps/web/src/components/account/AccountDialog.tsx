import { ExternalLinkIcon, LogOutIcon } from "lucide-react";

import { useAccountSession } from "../../cloud/accountSessionContext";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  closeAccountDialog,
  selectAccountDialogPage,
  useAccountDialogState,
  type AccountPageId,
} from "./accountDialogStore";
import { MobileClientsAccountPage } from "./MobileClientsAccountPage";
import { T3ConnectAccountPage } from "./T3ConnectAccountPage";

const PAGES: ReadonlyArray<{ readonly id: AccountPageId; readonly label: string }> = [
  { id: "t3-connect", label: "CodeWrench Connect" },
  { id: "mobile-clients", label: "Mobile Clients" },
];

/**
 * Account surface that replaces the hosted-provider modal: who is signed in, their registered
 * environments and mobile clients, a link to the provider's profile page, and sign out.
 */
export function AccountDialog() {
  const { open, page } = useAccountDialogState();
  const { identity, isSignedIn, openAccount, signOut } = useAccountSession();

  return (
    <Dialog open={open && isSignedIn} onOpenChange={(next) => !next && closeAccountDialog()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>
            {identity?.name ?? identity?.email ?? "Signed in"}
            {identity?.name && identity.email ? ` · ${identity.email}` : null}
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <ToggleGroup
              aria-label="Account section"
              value={[page]}
              onValueChange={(value) => {
                const next = PAGES.find((entry) => entry.id === value[0]);
                if (next) selectAccountDialogPage(next.id);
              }}
            >
              {PAGES.map((entry) => (
                <Toggle key={entry.id} value={entry.id}>
                  {entry.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="ms-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void openAccount()}>
                <ExternalLinkIcon />
                Manage Account
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  closeAccountDialog();
                  void signOut().catch(() =>
                    toastManager.add({
                      type: "error",
                      title: "Signed out, but this environment may still be open",
                      description: "Could not reach the environment to end its session. Try again.",
                    }),
                  );
                }}
              >
                <LogOutIcon />
                Sign Out
              </Button>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel>
          {page === "t3-connect" ? <T3ConnectAccountPage /> : <MobileClientsAccountPage />}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
