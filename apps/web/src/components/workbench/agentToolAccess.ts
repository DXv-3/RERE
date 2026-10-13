import {
  AGENT_TOOL_GROUPS,
  AGENT_TOOL_GROUP_LABELS,
  type AgentToolGroup,
} from "@t3tools/contracts";

/** The switches in the agent form, in the order the contract lists the groups. */
export const TOOL_ACCESS_OPTIONS: ReadonlyArray<{
  readonly group: AgentToolGroup;
  readonly label: string;
  readonly description: string;
}> = AGENT_TOOL_GROUPS.map((group) => ({
  group,
  label: AGENT_TOOL_GROUP_LABELS[group],
  description: {
    preview: "Open and drive pages in the browser panel.",
    device: "Use phone simulators.",
    orchestration:
      "Read, message, steer, or start other conversations, message other agents by name, and manage scheduled tasks. Its goals and its own conversation keep working.",
    worktree: "Create and inspect Git worktrees for its conversation.",
    "pull-requests": "Link its conversation to pull requests and list the ones linked.",
    media:
      "Look at video and image files in its folder, frame by frame, and read review notes on them.",
    campaigns:
      "Draft social posts for your clients and send them to you for approval. It can never approve, publish or change how much you are asked.",
  }[group],
}));

/**
 * The list to save after switching one group on or off. It is always a list, even an empty
 * one: the server keeps the stored setting when a save leaves the field out, so a save that
 * switches everything back on has to say so.
 */
export function withToolGroup(
  blocked: ReadonlyArray<AgentToolGroup> | undefined,
  group: AgentToolGroup,
  on: boolean,
): AgentToolGroup[] {
  const off = new Set(blocked ?? []);
  if (on) off.delete(group);
  else off.add(group);
  return AGENT_TOOL_GROUPS.filter((candidate) => off.has(candidate));
}
