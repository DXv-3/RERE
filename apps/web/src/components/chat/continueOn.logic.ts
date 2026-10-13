import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

/** What an environment must show before Continue On treats it as a place a thread can go. */
export interface ContinueOnEnvironmentFacts {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
}

function environmentSupportsThreadTransfer(
  facts: Pick<ContinueOnEnvironmentFacts, "serverConfig">,
): boolean {
  return facts.serverConfig?.environment.capabilities.threadTransfer === true;
}

/** Connected environments other than the thread's own that can import a transferred thread. */
export function continueOnTargetIds(
  sourceEnvironmentId: EnvironmentId,
  environments: ReadonlyArray<ContinueOnEnvironmentFacts>,
): ReadonlyArray<EnvironmentId> {
  return environments
    .filter(
      (environment) =>
        environment.environmentId !== sourceEnvironmentId &&
        environment.connected &&
        environmentSupportsThreadTransfer(environment),
    )
    .map((environment) => environment.environmentId);
}

const CONTINUE_ON_BUSY_REASON = "Wait for the current run to finish";

export type ContinueOnAvailability =
  /** Nothing to offer: the thread's server cannot export, or there is nowhere to continue. */
  | { readonly kind: "hidden" }
  | { readonly kind: "busy"; readonly reason: string }
  | { readonly kind: "available" };

/**
 * The thread must be quiet (the server refuses to export one with a run in progress), its own
 * server must be able to export, and some other connected environment must be able to import.
 */
export function resolveContinueOnAvailability(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly environments: ReadonlyArray<ContinueOnEnvironmentFacts>;
  readonly isBusy: boolean;
}): ContinueOnAvailability {
  const source = input.environments.find(
    (environment) => environment.environmentId === input.sourceEnvironmentId,
  );
  if (
    source === undefined ||
    !source.connected ||
    !environmentSupportsThreadTransfer(source) ||
    continueOnTargetIds(input.sourceEnvironmentId, input.environments).length === 0
  ) {
    return { kind: "hidden" };
  }
  return input.isBusy ? { kind: "busy", reason: CONTINUE_ON_BUSY_REASON } : { kind: "available" };
}
