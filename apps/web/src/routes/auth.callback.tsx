import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAccountSession } from "../cloud/accountSessionContext";
import { AuthSurfaceShell } from "../components/auth/AuthSurfaceShell";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/auth/callback")({
  component: AccountCallbackSurface,
});

/**
 * Where the sign-in provider sends the browser back. Exchanges the code for tokens, then returns
 * to the page the user started from.
 */
function AccountCallbackSurface() {
  const { completeCallback, signIn } = useAccountSession();
  const navigate = useNavigate();
  const [exchangeFailure, setFailure] = useState<string | null>(null);
  const failure = completeCallback ? exchangeFailure : "Sign-in is not available here.";

  useEffect(() => {
    if (!completeCallback) return;
    let cancelled = false;
    void completeCallback(window.location.href).then((result) => {
      if (cancelled) return;
      if (result.ok) void navigate({ to: result.returnTo, replace: true });
      else setFailure(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, [completeCallback, navigate]);

  return (
    <AuthSurfaceShell>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {failure ? "Sign-In Did Not Finish" : "Signing You In"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {failure ?? "Finishing your sign-in…"}
      </p>
      {failure ? (
        <div className="mt-6 flex gap-2">
          <Button type="button" onClick={() => void signIn()}>
            Try Again
          </Button>
          <Button type="button" variant="outline" onClick={() => void navigate({ to: "/" })}>
            Back to App
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}
