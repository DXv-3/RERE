import type { AccountSignInMode } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { useAccountSession } from "~/cloud/accountSessionContext";
import { resolveAccountAuthConfig } from "~/cloud/publicConfig";
import { connectAccount, probeAccountSignIn } from "~/connection/onboarding";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAccountSignInActions } from "../account/useAccountSignInActions";
import { Button } from "../ui/button";

const PROBE_DELAY_MS = 600;

/** Whether this build can hold an account at all: the desktop bridge or a configured provider. */
function hasAccountSignIn(): boolean {
  return Boolean(window.codewrenchAccount) || resolveAccountAuthConfig() !== null;
}

/**
 * Offers "Connect With My Account" in the add-environment dialog when the typed host says it lets
 * its owner in with an account. It renders nothing otherwise, so the pairing form stays the only
 * path for every environment that does not opt in, and it never stands in front of it.
 */
export function RemoteAccountConnect({
  host,
  disabled,
  onConnected,
}: {
  readonly host: string;
  readonly disabled: boolean;
  readonly onConnected: () => void;
}) {
  const account = useAccountSession();
  const { startSignIn } = useAccountSignInActions();
  const probe = useAtomCommand(probeAccountSignIn, { reportFailure: false });
  const connect = useAtomCommand(connectAccount, { reportFailure: false });
  // What was found, and which host it was found for: a different host shows nothing until probed.
  const [probed, setProbed] = useState<{
    readonly host: string;
    readonly mode: AccountSignInMode;
  } | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [failure, setFailure] = useState<{
    readonly host: string;
    readonly message: string;
  } | null>(null);
  const supported = hasAccountSignIn();
  const trimmedHost = host.trim();
  const mode = probed?.host === trimmedHost ? probed.mode : "off";
  const error = failure?.host === trimmedHost ? failure.message : null;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Look up what the environment offers once the person stops typing the host.
  useEffect(() => {
    if (!supported || trimmedHost.length < 3) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void probe({ host: trimmedHost }).then((result) => {
        if (!cancelled && result._tag === "Success") {
          setProbed({ host: trimmedHost, mode: result.value });
        }
      });
    }, PROBE_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [probe, supported, trimmedHost]);

  if (!supported || mode === "off" || !account.isLoaded) return null;

  const connectWithAccount = async () => {
    setIsConnecting(true);
    setFailure(null);
    const result = await connect({ host: trimmedHost, getAccountToken: account.getToken });
    if (!mountedRef.current) return;
    setIsConnecting(false);
    if (result._tag === "Success") {
      onConnected();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setFailure({
      host: trimmedHost,
      message: cause instanceof Error ? cause.message : "Could not connect with your account.",
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {account.isSignedIn
            ? `This environment lets its owner in with an account. You are signed in as ${
                account.identity?.email ?? account.identity?.name ?? "your account"
              }.`
            : "This environment lets its owner in with an account. Sign in to connect without a pairing code."}
        </p>
        {account.isSignedIn ? (
          <Button
            size="sm"
            className="shrink-0"
            disabled={disabled || isConnecting}
            onClick={() => void connectWithAccount()}
          >
            {isConnecting ? "Connecting…" : "Connect With My Account"}
          </Button>
        ) : (
          <Button size="sm" className="shrink-0" disabled={disabled} onClick={startSignIn}>
            Sign In
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
