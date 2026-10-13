import { LogInIcon, UserPlusIcon } from "lucide-react";

import { useAccountSession } from "../../cloud/accountSessionContext";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { openAccountDialog } from "./accountDialogStore";
import { useAccountSignInActions } from "./useAccountSignInActions";

export function AccountSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredAccountSidebarSignIn />;
}

export function AccountSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredAccountSidebarAvatar />;
}

/** Footer entry for the main sidebar: the avatar when signed in, a compact Sign In when not. */
export function AccountSidebarEntry() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredAccountSidebarEntry />;
}

function ConfiguredAccountSidebarEntry() {
  const { isLoaded, isSignedIn } = useAccountSession();
  if (!isLoaded) return null;
  return isSignedIn ? <ConfiguredAccountSidebarAvatar /> : <CompactAccountSidebarSignIn />;
}

function CompactAccountSidebarSignIn() {
  const { startSignIn } = useAccountSignInActions();
  return (
    <SidebarMenu className="w-auto shrink-0">
      <SidebarMenuItem>
        <SidebarMenuButton onClick={startSignIn}>
          <LogInIcon />
          <span>Sign In</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ConfiguredAccountSidebarAvatar() {
  const { identity, isLoaded, isSignedIn } = useAccountSession();
  if (!isLoaded || !isSignedIn) return null;
  const label = identity?.name ?? identity?.email ?? "Account";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <button
      type="button"
      aria-label={`Account: ${label}`}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold text-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => openAccountDialog()}
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-muted">
        {initial}
      </span>
    </button>
  );
}

function ConfiguredAccountSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAccountSession();
  const { startSignIn, startSignUp } = useAccountSignInActions();
  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={startSignIn}>
          <LogInIcon />
          <span>Sign In to CodeWrench Connect</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={startSignUp}>
          <UserPlusIcon />
          <span>Create Account</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
