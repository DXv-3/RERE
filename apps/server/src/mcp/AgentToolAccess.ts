import { AGENT_TOOL_GROUPS, type AgentToolGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";
import type * as McpSessionRegistry from "./McpSessionRegistry.ts";

/**
 * Takes the groups an agent's owner switched off out of what a call may use.
 *
 * The credential is untouched: it keeps the capabilities it was minted with, so the provider
 * session never needs a new one. Only the scope handed to this call changes, which is why a
 * switch applies to the very next tool call of a session that is already running.
 *
 * Only groups the credential actually holds count as blocked. A group it never had stays an
 * ordinary missing capability and keeps its own message.
 */
export const restrictScope = (
  scope: McpInvocationScope,
  blocked: ReadonlyArray<AgentToolGroup>,
): McpInvocationScope => {
  const blockedGroups = new Set<McpCapability>(
    blocked.filter((group) => scope.capabilities.has(group)),
  );
  if (blockedGroups.size === 0) return scope;
  return {
    ...scope,
    capabilities: new Set([...scope.capabilities].filter((group) => !blockedGroups.has(group))),
    blockedGroups,
  };
};

/**
 * Looks up the agent that owns the calling thread and applies its switches. A thread that
 * belongs to no agent comes back as the same object, after one read of the small agents table.
 *
 * If the lookup fails the owner's switches cannot be read, so every group is treated as switched
 * off for this call rather than letting a possible restriction lapse. The next call asks again.
 */
export const applyAgentToolAccess = (
  agents: Pick<AgentWorkspace.AgentWorkspace["Service"], "blockedToolGroups">,
  scope: McpInvocationScope,
) =>
  agents.blockedToolGroups(scope.threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("could not read the agent's tool access; refusing tool groups", {
        threadId: scope.threadId,
        reason: error.reason,
      }).pipe(Effect.as(AGENT_TOOL_GROUPS)),
    ),
    Effect.map((blocked) => restrictScope(scope, blocked)),
  );

/**
 * The scope for one MCP request: the credential's scope with its agent's switches applied.
 * `undefined` for an unknown or expired token.
 */
export const resolveCallScope = Effect.fn("AgentToolAccess.resolveCallScope")(function* (
  registry: Pick<McpSessionRegistry.McpSessionRegistryShape, "resolve">,
  agents: Pick<AgentWorkspace.AgentWorkspace["Service"], "blockedToolGroups">,
  rawToken: string,
) {
  const scope = yield* registry.resolve(rawToken);
  return scope === undefined ? undefined : yield* applyAgentToolAccess(agents, scope);
});
