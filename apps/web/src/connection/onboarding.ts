import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: { pairingUrl?: string; host?: string; pairingCode?: string }) =>
      JSON.stringify(input),
  },
  execute: (input: {
    readonly pairingUrl?: string;
    readonly host?: string;
    readonly pairingCode?: string;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

/** Whether the environment at `host` lets its owner connect with an account. Never fails. */
export const probeAccountSignIn = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:probe-account-sign-in",
  scheduler: onboardingScheduler,
  // A newer host replaces a probe still running for an older one.
  concurrency: { mode: "latest", key: () => "probe" },
  execute: (input: { readonly host: string }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.probeAccountSignIn(input)),
    ),
});

export const connectAccount = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-account",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: (input: { readonly host: string }) => input.host },
  execute: (input: {
    readonly host: string;
    readonly getAccountToken: (options?: {
      readonly forceRefresh?: boolean;
    }) => Promise<string | null>;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerAccount(input)),
    ),
});

/**
 * Ends and forgets every saved environment the account opened. Signing out of the account runs it,
 * so a remote machine that took the account as its credential asks for a sign-in again.
 */
export const signOutAccountConnections = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:sign-out-account-connections",
  scheduler: onboardingScheduler,
  concurrency: { mode: "serial", key: () => "sign-out" },
  execute: (_input: void) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.signOutAccountConnections()),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: { readonly target: DesktopSshEnvironmentTarget; readonly label?: string }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});
