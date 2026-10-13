import {
  EnvironmentAccountNotOwnerError,
  EnvironmentAccountSignInRateLimitedError,
  EnvironmentAccountSignInUnavailableError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyAccountSessionError,
  exchangeAccountToken,
  resolveAccountGateView,
  shouldAutoExchange,
  type AccountExchangeState,
  type AccountGateInput,
  resolveAccountOpenNotice,
} from "./accountGate";

const signedOut = { isLoaded: true, isSignedIn: false };
const signedIn = { isLoaded: true, isSignedIn: true };
const idle: AccountExchangeState = { status: "idle" };

function gate(overrides: Partial<AccountGateInput>): AccountGateInput {
  return {
    mode: "required",
    account: signedOut,
    exchange: idle,
    pairingChosen: false,
    ...overrides,
  };
}

describe("resolveAccountGateView", () => {
  it("shows only the pairing form when the environment offers no sign-in", () => {
    for (const mode of [undefined, "off"] as const) {
      expect(resolveAccountGateView(gate({ mode, account: signedIn }))).toEqual({
        kind: "pairing",
        offerSignIn: false,
      });
    }
  });

  it("makes sign-in the first screen in required mode, and the pairing form in allowed mode", () => {
    expect(resolveAccountGateView(gate({ mode: "required" }))).toEqual({ kind: "sign-in" });
    expect(resolveAccountGateView(gate({ mode: "allowed" }))).toEqual({
      kind: "pairing",
      offerSignIn: true,
    });
  });

  it("waits for the account to load before choosing a screen", () => {
    expect(
      resolveAccountGateView(gate({ account: { isLoaded: false, isSignedIn: false } })),
    ).toEqual({ kind: "working" });
  });

  it("goes straight in when signed in under required, and waits to be asked under allowed", () => {
    expect(resolveAccountGateView(gate({ mode: "required", account: signedIn }))).toEqual({
      kind: "working",
    });
    expect(resolveAccountGateView(gate({ mode: "allowed", account: signedIn }))).toEqual({
      kind: "pairing",
      offerSignIn: true,
    });
  });

  it("shows progress while the exchange runs or has just succeeded", () => {
    for (const exchange of [{ status: "pending" }, { status: "ok" }] as const) {
      expect(resolveAccountGateView(gate({ account: signedIn, exchange }))).toEqual({
        kind: "working",
      });
    }
  });

  it("says the machine belongs to someone else for any other account", () => {
    for (const mode of ["allowed", "required"] as const) {
      expect(
        resolveAccountGateView(
          gate({ mode, account: signedIn, exchange: { status: "not-owner" } }),
        ),
      ).toEqual({ kind: "not-owner" });
    }
  });

  it("offers a retry for failures, with the reason", () => {
    for (const reason of ["expired", "network", "rate-limited", "error"] as const) {
      expect(
        resolveAccountGateView(gate({ account: signedIn, exchange: { status: "failed", reason } })),
      ).toEqual({ kind: "retry", reason });
    }
  });

  it("always lets the visitor fall back to a pairing code", () => {
    for (const exchange of [
      idle,
      { status: "pending" },
      { status: "not-owner" },
      { status: "failed", reason: "network" },
    ] as const) {
      expect(
        resolveAccountGateView(gate({ account: signedIn, exchange, pairingChosen: true })),
      ).toEqual({ kind: "pairing", offerSignIn: true });
    }
  });

  it("falls back to pairing when the server stops offering sign-in mid-flow", () => {
    expect(
      resolveAccountGateView(gate({ account: signedIn, exchange: { status: "unavailable" } })),
    ).toEqual({ kind: "pairing", offerSignIn: false });
  });
});

describe("shouldAutoExchange", () => {
  it("starts by itself only when required, signed in, idle and not pairing", () => {
    expect(shouldAutoExchange(gate({ account: signedIn }))).toBe(true);
    expect(shouldAutoExchange(gate({ account: signedIn, mode: "allowed" }))).toBe(false);
    expect(shouldAutoExchange(gate({ account: signedOut }))).toBe(false);
    expect(shouldAutoExchange(gate({ account: signedIn, pairingChosen: true }))).toBe(false);
    for (const exchange of [
      { status: "pending" },
      { status: "not-owner" },
      { status: "failed", reason: "network" },
    ] as const) {
      expect(shouldAutoExchange(gate({ account: signedIn, exchange }))).toBe(false);
    }
  });
});

describe("exchangeAccountToken", () => {
  it("opens with the first token when the server accepts it", async () => {
    const post = vi.fn().mockResolvedValue({ status: "ok" });
    const getToken = vi.fn().mockResolvedValue("token-1");
    await expect(exchangeAccountToken({ getToken, post })).resolves.toEqual({ status: "ok" });
    expect(post).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith();
  });

  it("refreshes once and retries when the server refuses the token", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: "invalid-token" })
      .mockResolvedValueOnce({ status: "ok" });
    const getToken = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    await expect(exchangeAccountToken({ getToken, post })).resolves.toEqual({ status: "ok" });
    expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(post).toHaveBeenNthCalledWith(2, "new");
  });

  it("gives up after one refresh", async () => {
    const post = vi.fn().mockResolvedValue({ status: "invalid-token" });
    const getToken = vi.fn().mockResolvedValue("t");
    await expect(exchangeAccountToken({ getToken, post })).resolves.toEqual({
      status: "failed",
      reason: "expired",
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("reports an expired sign-in when no token can be had", async () => {
    const post = vi.fn();
    await expect(exchangeAccountToken({ getToken: async () => null, post })).resolves.toEqual({
      status: "failed",
      reason: "expired",
    });
    expect(post).not.toHaveBeenCalled();
    const refreshFails = vi.fn().mockResolvedValueOnce("t").mockResolvedValueOnce(null);
    await expect(
      exchangeAccountToken({
        getToken: refreshFails,
        post: async () => ({ status: "invalid-token" }),
      }),
    ).resolves.toEqual({ status: "failed", reason: "expired" });
  });

  it("does not retry a refusal that is about the account, not the token", async () => {
    for (const result of [
      { status: "not-owner" },
      { status: "unavailable" },
      { status: "failed", reason: "network" },
    ] as const) {
      const post = vi.fn().mockResolvedValue(result);
      await expect(exchangeAccountToken({ getToken: async () => "t", post })).resolves.toEqual(
        result,
      );
      expect(post).toHaveBeenCalledOnce();
    }
  });
});

describe("classifyAccountSessionError", () => {
  const traceId = "trace-1";
  it("maps each answer the endpoint can give", () => {
    expect(
      classifyAccountSessionError(
        new EnvironmentAccountNotOwnerError({ code: "account_not_owner", traceId }),
      ),
    ).toEqual({ status: "not-owner" });
    expect(
      classifyAccountSessionError(
        new EnvironmentAccountSignInUnavailableError({
          code: "account_sign_in_unavailable",
          traceId,
        }),
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      classifyAccountSessionError(
        new EnvironmentAccountSignInRateLimitedError({
          code: "account_sign_in_rate_limited",
          traceId,
        }),
      ),
    ).toEqual({ status: "failed", reason: "rate-limited" });
    for (const reason of ["missing_credential", "invalid_credential"] as const) {
      expect(
        classifyAccountSessionError(
          new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId }),
        ),
      ).toEqual({ status: "invalid-token" });
    }
    expect(
      classifyAccountSessionError(
        new EnvironmentInternalError({
          code: "internal_error",
          reason: "browser_session_issuance_failed",
          traceId,
        }),
      ),
    ).toEqual({ status: "failed", reason: "error" });
  });

  it("treats anything that never got an answer as a network failure to retry", () => {
    expect(classifyAccountSessionError(new TypeError("Failed to fetch"))).toEqual({
      status: "failed",
      reason: "network",
    });
    expect(classifyAccountSessionError(undefined)).toEqual({
      status: "failed",
      reason: "network",
    });
  });

  it("never reads a refusal as success", () => {
    for (const error of [new Error("x"), "ok", { status: "ok" }, null]) {
      expect(classifyAccountSessionError(error).status).not.toBe("ok");
    }
  });
});

describe("resolveAccountOpenNotice", () => {
  it("reports every answer on the pairing form instead of staying silent", () => {
    expect(resolveAccountOpenNotice({ status: "idle" })).toEqual({ kind: "none" });
    expect(resolveAccountOpenNotice({ status: "pending" })).toEqual({ kind: "checking" });
    expect(resolveAccountOpenNotice({ status: "not-owner" })).toEqual({ kind: "not-owner" });
    expect(resolveAccountOpenNotice({ status: "failed", reason: "network" })).toEqual({
      kind: "retry",
      reason: "network",
    });
  });
});
