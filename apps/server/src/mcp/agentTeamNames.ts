import {
  AGENT_LIST_GOAL_MAX,
  AGENT_LIST_ROLE_MAX,
  type AgentTeamStatus,
  type OrchestrationV2ThreadShell,
  type WorkspaceAgent,
} from "@t3tools/contracts";

/** Lower case with runs of whitespace collapsed, so "  Career   Apply " matches "career apply". */
const normalizeAgentName = (value: string): string =>
  value.trim().replace(/\s+/gu, " ").toLowerCase();

export type AgentMatch =
  | { readonly _tag: "found"; readonly agent: WorkspaceAgent }
  | { readonly _tag: "unknown"; readonly closeMatches: ReadonlyArray<WorkspaceAgent> }
  | { readonly _tag: "ambiguous"; readonly candidates: ReadonlyArray<WorkspaceAgent> };

const MAX_CLOSE_MATCHES = 5;

/** Edit distance, capped: only used to tell a typo from an unrelated name. */
const editDistance = (left: string, right: string): number => {
  if (Math.abs(left.length - right.length) > 3) return 4;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 4;
};

/**
 * Finds the agent a caller means by exact id or by name, ignoring case. Archived agents are not
 * candidates. Two agents with the same name are ambiguous rather than guessed between, so the
 * caller has to use an id. An unknown name returns the nearest names so the error can offer them.
 */
export function matchAgent(agents: ReadonlyArray<WorkspaceAgent>, query: string): AgentMatch {
  const live = agents.filter((agent) => !agent.archivedAt);
  const trimmed = query.trim();
  const byId = live.find((agent) => agent.profile.id.toLowerCase() === trimmed.toLowerCase());
  if (byId) return { _tag: "found", agent: byId };
  const wanted = normalizeAgentName(trimmed);
  const exact = live.filter((agent) => normalizeAgentName(agent.profile.name) === wanted);
  if (exact.length === 1) return { _tag: "found", agent: exact[0]! };
  if (exact.length > 1) return { _tag: "ambiguous", candidates: exact.slice(0, MAX_CLOSE_MATCHES) };
  const scored = live
    .map((agent) => {
      const name = normalizeAgentName(agent.profile.name);
      const related = name.includes(wanted) || wanted.includes(name);
      return { agent, score: related ? 0 : editDistance(name, wanted) };
    })
    .filter(({ score }) => score <= 2)
    .toSorted((left, right) => left.score - right.score);
  return {
    _tag: "unknown",
    closeMatches: scored.slice(0, MAX_CLOSE_MATCHES).map(({ agent }) => agent),
  };
}

/** "Name (id)" lines for an error message. */
export const describeAgents = (agents: ReadonlyArray<WorkspaceAgent>): string =>
  agents.map((agent) => `${agent.profile.name} (${agent.profile.id})`).join(", ");

const firstLine = (value: string): string => value.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/** A short bounded line saying what the agent is for. Never more than the first line of instructions. */
export const agentRole = (agent: WorkspaceAgent): string =>
  truncate(
    firstLine(agent.profile.description) || firstLine(agent.profile.instructions),
    AGENT_LIST_ROLE_MAX,
  );

export const agentCurrentGoal = (agent: WorkspaceAgent): string | null => {
  const title = agent.goals?.find((goal) => goal.status === "active")?.title;
  return title === undefined ? null : truncate(title, AGENT_LIST_GOAL_MAX);
};

/** The agent's state as its own conversation shows it: waiting on the owner outranks working. */
export const agentStatusFromShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "status" | "activeRunId" | "pendingRuntimeRequest"
  > | null,
): AgentTeamStatus => {
  if (shell === null) return "idle";
  if (shell.pendingRuntimeRequest !== null) return "needs_input";
  if (shell.status === "failed") return "failed";
  return shell.activeRunId !== null ||
    shell.status === "preparing" ||
    shell.status === "queued" ||
    shell.status === "starting" ||
    shell.status === "running" ||
    shell.status === "waiting"
    ? "working"
    : "idle";
};
