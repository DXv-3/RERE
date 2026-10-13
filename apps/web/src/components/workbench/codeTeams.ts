/** One agent in a team launch. An empty task falls back to the team's shared task. */
export interface TeamMember {
  kind: "claude" | "codex";
  role: string;
  task: string;
}
/** A set of agents started together, each with its opening prompt. */
export interface CodeTeam {
  task: string;
  members: TeamMember[];
  /** Give every member its own git worktree and branch instead of the shared folder. */
  isolate: boolean;
}
export interface SavedCodeTeam extends CodeTeam {
  name: string;
}

export const MAX_TEAM_MEMBERS = 6;
export const MAX_SAVED_TEAMS = 8;
const MAX_TASK_LENGTH = 4_000;

/** The opening prompt for a member: its own task or the shared one, led by its role. */
export function memberPrompt(member: TeamMember, sharedTask: string): string {
  const task = (member.task.trim() || sharedTask.trim()).slice(0, MAX_TASK_LENGTH);
  const role = member.role.trim();
  return task && role ? `Your role on this team: ${role}. ${task}` : task;
}

/** A branch name for a member's worktree, unique per launch through the pane id. */
export function worktreeBranch(role: string, paneId: string): string {
  const slug = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `workbench/${slug || "agent"}-${paneId.replace(/[^a-z0-9]/gi, "").slice(-6)}`;
}

const counts: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};
const isolation =
  /[,\s]*\b(?:(?:with|in|using|on|each in)\s+)?(?:(?:their|its) own|separate|isolated)\s+(?:git\s+)?(?:worktrees?|branch(?:es)?|folders?)(?:\s+(?:each|per agent))?\b|[,\s]*\b(?:with\s+)?worktrees?\b|[,\s]*\bisolated\b/gi;
const agentWords = ["claude", "codex", "agent", "agents", "pane", "panes", "session", "sessions"];
const filler = new Set([...agentWords, "code", "with", "as", "the"]);

/**
 * Turns a spoken or typed sentence into a team to review before launching, such as
 * "start a builder and two reviewers on the login bug with separate worktrees".
 * Who is on the team comes before "to", "on", "for" or a colon; the task comes
 * after. Returns null when the sentence names nobody.
 */
export function describeTeam(sentence: string): CodeTeam | null {
  const isolate = isolation.test(sentence);
  isolation.lastIndex = 0;
  const plain = sentence
    .replace(isolation, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  const split = /\s*:\s*|\s+(?:to|on|for)\s+/i.exec(plain);
  const who = (split ? plain.slice(0, split.index) : plain).replace(
    /^(?:please\s+)?(?:start|launch|spin up|create|open|run|set up|give me|i want|i need)\s+/i,
    "",
  );
  const task = split ? plain.slice(split.index + split[0].length).trim() : "";
  const members: TeamMember[] = [];
  for (const part of who.split(/\s*,\s*|\s+(?:and|plus)\s+/i)) {
    const words = part.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const count = counts[words[0]!] ?? (/^[1-6]$/.test(words[0]!) ? Number(words[0]) : undefined);
    const named = words.slice(count === undefined ? 0 : 1);
    // A part with no count must at least mention an agent, or it is not about the team.
    if (count === undefined && !named.some((word) => agentWords.includes(word))) continue;
    const role = named
      .filter((word) => !filler.has(word))
      .map((word, index, all) =>
        index === all.length - 1 && (count ?? 1) > 1 ? word.replace(/s$/, "") : word,
      )
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
      .slice(0, 40);
    for (let index = 0; index < (count ?? 1) && members.length < MAX_TEAM_MEMBERS; index++)
      members.push({ kind: named.includes("codex") ? "codex" : "claude", role, task: "" });
  }
  if (members.length === 0) return null;
  return { task: task.charAt(0).toUpperCase() + task.slice(1), members, isolate };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

export function readTeams(value: unknown): SavedCodeTeam[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (team): team is SavedCodeTeam =>
        text(team?.name, 40) &&
        team.name.trim().length > 0 &&
        text(team.task, MAX_TASK_LENGTH) &&
        Array.isArray(team.members) &&
        team.members.length > 0 &&
        team.members.length <= MAX_TEAM_MEMBERS &&
        team.members.every(
          (member: Partial<TeamMember> | null) =>
            (member?.kind === "claude" || member?.kind === "codex") &&
            text(member.role, 40) &&
            text(member.task, MAX_TASK_LENGTH),
        ),
    )
    .map(({ name, task, members, isolate }) => ({
      name,
      task,
      isolate: isolate === true,
      members: members.map(({ kind, role, task: own }) => ({ kind, role, task: own })),
    }))
    .slice(0, MAX_SAVED_TEAMS);
}
