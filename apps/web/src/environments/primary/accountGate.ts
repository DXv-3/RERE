import {
  EnvironmentAccountNotOwnerError,
  EnvironmentAccountSignInRateLimitedError,
  EnvironmentAccountSignInUnavailableError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
} from "@t3tools/contracts";
import type { AccountSignInMode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * How an attempt to open this environment with the signed-in account ended. `expired` means the
 * account token was refused even after a refresh, so the person has to sign in again.
 */
export type AccountExchangeOutcome =
  | { readonly status: "ok" }
  | { readonly status: "not-owner" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "failed";
      readonly reason: "expired" | "network" | "rate-limited" | "error";
    };

export type AccountExchangeState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | AccountExchangeOutcome;

export interface AccountGateInput {
  /** What the environment advertises. Absent means it offers no account sign-in. */
  readonly mode: AccountSignInMode | undefined;
  readonly account: { readonly isLoaded: boolean; readonly isSignedIn: boolean };
  readonly exchange: AccountExchangeState;
  /** The visitor chose "Use a pairing code instead". */
  readonly pairingChosen: boolean;
}

/** What the first screen shows. The pairing form is always reachable; sign-in is added to it. */
export type AccountGateView =
  | { readonly kind: "pairing"; readonly offerSignIn: boolean }
  | { readonly kind: "sign-in" }
  | { readonly kind: "working" }
  | { readonly kind: "not-owner" }
  | {
      readonly kind: "retry";
      readonly reason: "expired" | "network" | "rate-limited" | "error";
    };

export function resolveAccountGateView(input: AccountGateInput): AccountGateView {
  const mode = input.mode ?? "off";
  if (mode === "off" || input.exchange.status === "unavailable") {
    return { kind: "pairing", offerSignIn: false };
  }
  if (input.pairingChosen) {
    return { kind: "pairing", offerSignIn: true };
  }
  if (input.exchange.status === "pending" || input.exchange.status === "ok") {
    return { kind: "working" };
  }
  if (input.exchange.status === "not-owner") {
    return { kind: "not-owner" };
  }
  if (input.exchange.status === "failed") {
    return { kind: "retry", reason: input.exchange.reason };
  }
  if (!input.account.isLoaded) {
    return { kind: "working" };
  }
  if (!input.account.isSignedIn) {
    return mode === "required" ? { kind: "sign-in" } : { kind: "pairing", offerSignIn: true };
  }
  // Signed in, nothing tried yet. `required` goes straight in; `allowed` waits for the person to
  // choose, because an account that is only signed in to reach its own machines should not be
  // turned away from a machine it meant to open with a pairing code.
  return mode === "required" ? { kind: "working" } : { kind: "pairing", offerSignIn: true };
}

/**
 * What the pairing form's account button reports after it was pressed. The form stays on screen
 * whatever the answer, so the answer has to be said there.
 */
export type AccountOpenNotice =
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | { readonly kind: "not-owner" }
  | { readonly kind: "retry"; readonly reason: "expired" | "network" | "rate-limited" | "error" };

export function resolveAccountOpenNotice(exchange: AccountExchangeState): AccountOpenNotice {
  switch (exchange.status) {
    case "pending":
    case "ok":
      return { kind: "checking" };
    case "not-owner":
      return { kind: "not-owner" };
    case "failed":
      return { kind: "retry", reason: exchange.reason };
    default:
      return { kind: "none" };
  }
}

/** Whether the surface should start the exchange by itself now. */
export function shouldAutoExchange(input: AccountGateInput): boolean {
  return (
    input.mode === "required" &&
    !input.pairingChosen &&
    input.account.isLoaded &&
    input.account.isSignedIn &&
    input.exchange.status === "idle"
  );
}

export type AccountSessionPostResult =
  | AccountExchangeOutcome
  /** The server refused the token itself: expired, wrong signer, wrong audience. */
  | { readonly status: "invalid-token" };

/**
 * Trades the account's access token for an environment session. A token the server refuses is
 * replaced by a refreshed one and tried once more, which covers a token that expired between
 * sign-in and now; a second refusal means the person has to sign in again.
 */
export async function exchangeAccountToken(deps: {
  readonly getToken: (options?: { readonly forceRefresh?: boolean }) => Promise<string | null>;
  readonly post: (token: string) => Promise<AccountSessionPostResult>;
}): Promise<AccountExchangeOutcome> {
  const expired = { status: "failed", reason: "expired" } as const;
  const first = await deps.getToken();
  if (first === null) return expired;
  const firstResult = await deps.post(first);
  if (firstResult.status !== "invalid-token") return firstResult;

  const refreshed = await deps.getToken({ forceRefresh: true });
  if (refreshed === null) return expired;
  const secondResult = await deps.post(refreshed);
  return secondResult.status === "invalid-token" ? expired : secondResult;
}

const isNotOwner = Schema.is(EnvironmentAccountNotOwnerError);
const isUnavailable = Schema.is(EnvironmentAccountSignInUnavailableError);
const isRateLimited = Schema.is(EnvironmentAccountSignInRateLimitedError);
const isAuthInvalid = Schema.is(EnvironmentAuthInvalidError);
const isInternal = Schema.is(EnvironmentInternalError);

/** Maps what the exchange endpoint threw to something the gate can act on. */
export function classifyAccountSessionError(error: unknown): AccountSessionPostResult {
  if (isNotOwner(error)) return { status: "not-owner" };
  if (isUnavailable(error)) return { status: "unavailable" };
  if (isRateLimited(error)) return { status: "failed", reason: "rate-limited" };
  if (isAuthInvalid(error)) return { status: "invalid-token" };
  if (isInternal(error)) return { status: "failed", reason: "error" };
  // A request that never got an answer (offline, dropped, proxy error) can simply be tried again.
  return { status: "failed", reason: "network" };
}
