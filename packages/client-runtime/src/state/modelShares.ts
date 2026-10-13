import type { ModelShareCreateInput } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  createEnvironmentModelShare,
  fetchEnvironmentModelShares,
  revokeEnvironmentModelShare,
} from "./modelSharesHttp.ts";
import { createEnvironmentCommand } from "./runtime.ts";

/** @public Required to name the error in consumers' inferred command results. */
export class ModelSharesConnectionNotReadyError extends Data.TaggedError(
  "ModelSharesConnectionNotReadyError",
)<{ readonly message: string }> {}

/**
 * Resolves the environment's current prepared connection together with the relay services its
 * credential may need, the same inputs every authenticated environment HTTP request takes.
 */
const resolveRequestInput = Effect.gen(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new ModelSharesConnectionNotReadyError({
      message: "This machine is not connected yet. Try again in a moment.",
    });
  }
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return { prepared: prepared.value, signer, remoteAuthorization };
});

/**
 * Model share management on any connected environment, over that environment's own HTTP API.
 * Each command takes the environment to act on, so the Shared models panel is not tied to the
 * primary one.
 */
export function createModelShareEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    list: createEnvironmentCommand(runtime, {
      label: "environment-data:model-shares:list",
      execute: (_input: null) =>
        resolveRequestInput.pipe(Effect.flatMap(fetchEnvironmentModelShares)),
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:model-shares:create",
      execute: (share: ModelShareCreateInput) =>
        resolveRequestInput.pipe(
          Effect.flatMap((input) => createEnvironmentModelShare({ ...input, share })),
        ),
    }),
    revoke: createEnvironmentCommand(runtime, {
      label: "environment-data:model-shares:revoke",
      execute: (shareId: string) =>
        resolveRequestInput.pipe(
          Effect.flatMap((input) => revokeEnvironmentModelShare({ ...input, shareId })),
        ),
    }),
  };
}
