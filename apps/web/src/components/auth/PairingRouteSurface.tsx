import { Alert, AlertDescription } from "../ui/alert";
import type { AccountSignInMode, AuthSessionState } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_DOWNLOAD_URL } from "../../branding";
import { useAccountSession } from "../../cloud/accountSessionContext";
import { hasCloudPublicConfig, resolveAccountAuthConfig } from "../../cloud/publicConfig";
import { connectPairing } from "../../connection/onboarding";
import {
  exchangeAccountToken,
  resolveAccountGateView,
  shouldAutoExchange,
  type AccountExchangeState,
  resolveAccountOpenNotice,
  type AccountOpenNotice,
} from "../../environments/primary/accountGate";
import {
  canOpenWithDesktopBootstrap,
  finishAccountSignIn,
  openWithDesktopBootstrap,
  peekPairingTokenFromUrl,
  postAccountSession,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  accountSignIn,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  /** What this environment advertises about opening it with an account. */
  accountSignIn?: AccountSignInMode;
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const account = useAccountSession();
  // This build can only offer sign-in if it knows an account provider; otherwise the button would
  // do nothing, so the page behaves as if the environment offered none.
  const mode = hasAccountSignIn() ? accountSignIn : undefined;
  const [pairingChosen, setPairingChosen] = useState(() => peekPairingTokenFromUrl() !== null);
  // An outcome belongs to the account that produced it; another account starts clean.
  const accountKey = account.identity?.userId ?? null;
  const [exchangeRecord, setExchangeRecord] = useState<{
    readonly accountKey: string | null;
    readonly state: AccountExchangeState;
  }>({ accountKey, state: { status: "idle" } });
  const exchange: AccountExchangeState =
    exchangeRecord.accountKey === accountKey ? exchangeRecord.state : { status: "idle" };
  const gateInput = {
    mode,
    account: { isLoaded: account.isLoaded, isSignedIn: account.isSignedIn },
    exchange,
    pairingChosen,
  } as const;
  const view = resolveAccountGateView(gateInput);

  const runAccountExchange = useCallback(async () => {
    const setState = (state: AccountExchangeState) => setExchangeRecord({ accountKey, state });
    setState({ status: "pending" });
    const outcome = await exchangeAccountToken({
      getToken: account.getToken,
      post: postAccountSession,
    });
    if (outcome.status !== "ok") {
      setState(outcome);
      return;
    }
    const opened = await finishAccountSignIn().then(
      () => true,
      () => false,
    );
    if (!opened) {
      setState({ status: "failed", reason: "network" });
      return;
    }
    setState(outcome);
    startTransition(() => {
      onAuthenticated();
    });
  }, [account.getToken, accountKey, onAuthenticated]);

  const autoExchange = shouldAutoExchange(gateInput);
  useEffect(() => {
    if (autoExchange) void runAccountExchange();
  }, [autoExchange, runAccountExchange]);
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  // The desktop app's way past an account gate when signing in is not possible right now.
  const openOnThisComputer = useCallback(async () => {
    setIsSubmitting(true);
    setErrorMessage("");
    const openError = await openWithDesktopBootstrap().then(
      () => null,
      (error) => errorMessageFromUnknown(error),
    );
    setIsSubmitting(false);
    if (openError) {
      setErrorMessage(openError);
      return;
    }
    startTransition(() => {
      onAuthenticated();
    });
  }, [onAuthenticated]);

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  if (view.kind !== "pairing") {
    return (
      <AccountGateSurface
        view={view}
        onRetry={() => void runAccountExchange()}
        onUsePairingCode={() => setPairingChosen(true)}
      />
    );
  }

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pair with this environment"
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            Pairing token
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => setCredential(event.currentTarget.value)}
            placeholder="Paste a one-time token or pairing secret"
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Pairing..." : "Continue"}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
          {view.offerSignIn && canOpenWithDesktopBootstrap() ? (
            <Button
              disabled={isSubmitting}
              onClick={() => void openOnThisComputer()}
              size="sm"
              variant="ghost"
            >
              Open On This Computer
            </Button>
          ) : null}
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>

      {view.offerSignIn ? (
        <AccountOpenSection
          notice={resolveAccountOpenNotice(exchange)}
          onOpen={() => void runAccountExchange()}
        />
      ) : hasCloudPublicConfig() ? (
        <PairingAccountSection />
      ) : null}
    </StandalonePage>
  );
}

function hasAccountSignIn(): boolean {
  return window.codewrenchAccount !== undefined || resolveAccountAuthConfig() !== null;
}

/** Runs a sign-in starter and shows a failure to start in place; this page has no toast host. */
function useAccountActionRunner() {
  const [errorMessage, setErrorMessage] = useState("");
  const run = (action: () => Promise<void>) => {
    setErrorMessage("");
    void action().catch((cause: unknown) => setErrorMessage(errorMessageFromUnknown(cause)));
  };
  return { errorMessage, run };
}

/** The pairing form's way in for an account: opens this environment if the account is its owner. */
function AccountOpenSection({
  notice,
  onOpen,
}: {
  readonly notice: AccountOpenNotice;
  readonly onOpen: () => void;
}) {
  const { identity, isSignedIn, signIn, signOut, signUp } = useAccountSession();
  const { errorMessage, run } = useAccountActionRunner();
  const checking = notice.kind === "checking";

  return (
    <section className="mt-6 border-t border-border/70 pt-5">
      <h2 className="text-sm font-medium">Or open it with your account</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        If this is your own machine, signing in with the account it is linked to opens it without a
        pairing code.
      </p>

      {errorMessage ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      {notice.kind === "not-owner" ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>
            Your account works, but this machine is linked to a different account, so it stays
            closed to you. To use {APP_BASE_NAME} yourself,{" "}
            <a className="underline" href={APP_DOWNLOAD_URL}>
              download the app
            </a>{" "}
            and sign in there.
          </AlertDescription>
        </Alert>
      ) : notice.kind === "retry" ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>
            {RETRY_COPY[notice.reason].title}. {RETRY_COPY[notice.reason].description}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2" aria-live="polite">
        {isSignedIn ? (
          <>
            <Button size="sm" disabled={checking} onClick={onOpen}>
              {checking
                ? "Checking Your Account…"
                : `Continue as ${identity?.email ?? identity?.name ?? "your account"}`}
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(signOut)}>
              Sign Out
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" onClick={() => run(signIn)}>
              Sign In
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(signUp)}>
              Create Account
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

const RETRY_COPY = {
  expired: {
    title: "Your sign-in expired",
    description: "Sign in again to open this environment.",
  },
  network: {
    title: "Could not reach this environment",
    description: "Check your connection and try again.",
  },
  "rate-limited": {
    title: "Too many attempts",
    description: "Wait a minute, then try again.",
  },
  error: {
    title: "Something went wrong",
    description: "The environment could not open a session. Try again.",
  },
} as const;

/** Every screen of the account gate except the pairing form itself. */
function AccountGateSurface({
  view,
  onRetry,
  onUsePairingCode,
}: {
  readonly view: Exclude<ReturnType<typeof resolveAccountGateView>, { kind: "pairing" }>;
  readonly onRetry: () => void;
  readonly onUsePairingCode: () => void;
}) {
  const { identity, signIn, signOut, signUp } = useAccountSession();
  const { errorMessage, run } = useAccountActionRunner();
  const pairingLink = (
    <Button size="sm" variant="ghost" onClick={onUsePairingCode}>
      Use a pairing code instead
    </Button>
  );
  const signedInAs = identity?.email ?? identity?.name ?? "your account";

  let title: string;
  let description: string;
  let actions: React.ReactNode;
  switch (view.kind) {
    case "sign-in":
      title = "Sign in to open this environment";
      description =
        "This environment opens with the account it is linked to. Sign in, or create an account if you are new.";
      actions = (
        <>
          <Button size="sm" onClick={() => run(signIn)}>
            Sign In
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(signUp)}>
            Create Account
          </Button>
          {pairingLink}
        </>
      );
      break;
    case "working":
      title = "Opening this environment";
      description = "Checking your account.";
      actions = pairingLink;
      break;
    case "not-owner":
      title = "Your account works. This machine is someone else's.";
      description = `You are signed in as ${signedInAs}. This address is a private machine linked to another account, so it stays closed to you. To use ${APP_BASE_NAME} yourself, download the app and sign in there.`;
      actions = (
        <>
          <Button size="sm" render={<a href={APP_DOWNLOAD_URL} />}>
            Download {APP_BASE_NAME}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(signOut)}>
            Sign Out
          </Button>
          {pairingLink}
        </>
      );
      break;
    case "retry":
      title = RETRY_COPY[view.reason].title;
      description = RETRY_COPY[view.reason].description;
      actions = (
        <>
          {view.reason === "expired" ? (
            <Button size="sm" onClick={() => run(signIn)}>
              Sign In Again
            </Button>
          ) : (
            <Button size="sm" onClick={onRetry}>
              Try Again
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => run(signOut)}>
            Sign Out
          </Button>
          {pairingLink}
        </>
      );
      break;
  }

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader eyebrow={APP_DISPLAY_NAME} title={title} description={description} />
      {errorMessage ? (
        <Alert variant="error" className="mt-4">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2" aria-live="polite">
        {actions}
      </div>
    </StandalonePage>
  );
}

/**
 * The way to an account for someone who landed here without a pairing link. Signing in does not
 * pair: an account connects a person's own machines, and this environment still needs its owner's
 * link, so the section says which of the two the visitor now has.
 */
function PairingAccountSection() {
  const { identity, isLoaded, isSignedIn, signIn, signOut, signUp } = useAccountSession();
  const [errorMessage, setErrorMessage] = useState("");
  // This page has no toast host, so a failure to reach the sign-in page is shown in place.
  const run = (action: () => Promise<void>) => {
    setErrorMessage("");
    void action().catch((cause: unknown) => setErrorMessage(errorMessageFromUnknown(cause)));
  };

  if (!isLoaded) return null;

  return (
    <section className="mt-6 border-t border-border/70 pt-5">
      <h2 className="text-sm font-medium">
        {isSignedIn
          ? `Signed in as ${identity?.email ?? identity?.name ?? "your account"}`
          : `New to ${APP_DISPLAY_NAME}?`}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {isSignedIn
          ? `Your account is ready. Sign in with it in the ${APP_DISPLAY_NAME} app on your own computer to connect your machines. Opening this environment still takes a pairing link from its owner.`
          : `Create a free account to connect your own computers and phone. An account does not open this environment: that takes a pairing link from its owner.`}
      </p>

      {errorMessage ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {isSignedIn ? (
          <Button size="sm" variant="outline" onClick={() => run(signOut)}>
            Sign Out
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => run(signUp)}>
              Create Account
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(signIn)}>
              Sign In
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This one-time pairing token was already submitted. Request a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  }, [connectPairingEnvironment]);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  const request = hostedPairingRequestRef.current;

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={
          status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"
        }
        description={message}
      />

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <Alert variant="error" className="mt-5">
          <AlertDescription>
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            Pairing...
          </Button>
        ) : canRetry ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "This environment is private. Open the pairing link its owner sent you, or paste the token from it here.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
