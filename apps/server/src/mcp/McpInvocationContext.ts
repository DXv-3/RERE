import {
  type AgentToolGroup,
  agentToolGroupSwitchedOffMessage,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * What a credential can be granted. These are the same five groups an owner can switch off for
 * one agent, so a new capability has to be added to the contract list too.
 */
export type McpCapability = AgentToolGroup;

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** What this call may use: the credential's capabilities minus what the agent's owner switched off. */
  readonly capabilities: ReadonlySet<McpCapability>;
  /**
   * Groups the credential holds but the owner of the calling agent switched off, applied when the
   * call arrives (see `AgentToolAccess`). Absent for threads that belong to no agent. A blocked
   * group is not in `capabilities`, so a check that was never taught about this field refuses.
   */
  readonly blockedGroups?: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

/** True when the credential holds `group` but the owner switched it off for the calling agent. */
export const isSwitchedOff = (scope: McpInvocationScope, group: McpCapability): boolean =>
  scope.blockedGroups?.has(group) === true;

/** `fallback` unless the owner switched `group` off for the calling agent, which names the switch. */
export const capabilityDeniedMessage = (
  scope: McpInvocationScope,
  group: McpCapability,
  fallback: string,
): string => (isSwitchedOff(scope, group) ? agentToolGroupSwitchedOffMessage(group) : fallback);

/**
 * Whether the credential was granted orchestration, even if the agent's owner switched Other
 * Conversations off. That switch stops reaching beyond the agent's own thread; the agent's goal
 * tools and its own conversation stay available, and they check this instead of `capabilities`.
 */
export const holdsOrchestration = (scope: McpInvocationScope): boolean =>
  scope.capabilities.has("orchestration") || isSwitchedOff(scope, "orchestration");

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  const withReason = isSwitchedOff(invocation, capability)
    ? { ...fields, reason: agentToolGroupSwitchedOffMessage(capability) }
    : fields;
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...withReason })
    : new McpCapabilityUnavailableError({ capability, ...withReason });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      // The conditional type narrows what the literal argument decided at runtime.
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );
