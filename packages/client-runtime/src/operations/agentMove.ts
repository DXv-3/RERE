import type { WorkspaceAgent } from "@t3tools/contracts";

import type { EnvironmentProject } from "../state/models.ts";
import { deriveLogicalProjectKey } from "../state/projectGrouping.ts";

/**
 * Agents live in one environment each. Moving one means saving a rebuilt record on the
 * target environment and archiving the source copy. Everything here is pure so web and
 * mobile share the same rules; the caller owns the saves.
 */

export type AgentMoveProject = Pick<
  EnvironmentProject,
  "environmentId" | "id" | "workspaceRoot" | "repositoryIdentity"
>;

export interface AgentMoveProvider {
  readonly instanceId: string;
  readonly enabled: boolean;
  /** When given, the agent's model must be one of these; two machines can share an instance id. */
  readonly models?: ReadonlyArray<{ readonly slug: string }>;
}

export type AgentMoveNote =
  | "model_unavailable"
  | "machine_only_model"
  | "project_missing"
  | "archive_differs";

export const AGENT_MOVE_MESSAGES = {
  willMove: "Will move.",
  model_unavailable: "Model is not available on the target (will use the target's default).",
  machine_only_model:
    "Uses a model that only exists on this machine (stays here unless you choose to move it).",
  project_missing: "Project not found on the target (will use the personal workspace).",
  archive_differs:
    "Its imported history differs from the copy on the target, which cannot be changed. It cannot be moved.",
} as const satisfies Record<AgentMoveNote | "willMove", string>;

export interface AgentMoveVerdict {
  readonly agentId: string;
  readonly name: string;
  /** `create` makes a new record on the target; `merge` updates one with the same id. */
  readonly mode: "create" | "merge";
  readonly notes: ReadonlyArray<AgentMoveNote>;
  readonly messages: ReadonlyArray<string>;
  /** The move cannot be saved on the target at all. */
  readonly blocked: boolean;
  /** The UI should leave this agent unchecked until the user opts in. */
  readonly stayByDefault: boolean;
}

export interface AgentMovePlan {
  readonly verdict: AgentMoveVerdict;
  /** The record to save on the target; null when the move is blocked. */
  readonly record: WorkspaceAgent | null;
  /** 0 creates the record, otherwise the target's current revision. */
  readonly expectedRevision: number;
}

export interface AgentMoveInput {
  readonly source: WorkspaceAgent;
  readonly targetAgents: ReadonlyArray<WorkspaceAgent>;
  readonly sourceProjects: ReadonlyArray<AgentMoveProject>;
  readonly targetProjects: ReadonlyArray<AgentMoveProject>;
  readonly targetProviders: ReadonlyArray<AgentMoveProvider>;
}

function parseProjectKey(key: string): readonly [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/**
 * Target projects that are the same repository as the source, with the one to preselect: the
 * project at the same folder inside the repository, else the only project for that repository.
 * Shared with Continue On, which asks the user to choose when nothing is preselected.
 */
export function matchTargetProjects<Candidate extends AgentMoveProject>(
  sourceProject: AgentMoveProject,
  targetProjects: ReadonlyArray<Candidate>,
): { readonly candidates: ReadonlyArray<Candidate>; readonly preselected: Candidate | null } {
  const canonicalKey = sourceProject.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) return { candidates: [], preselected: null };
  const sameRepository = targetProjects.filter(
    (project) => project.repositoryIdentity?.canonicalKey === canonicalKey,
  );
  const sourcePathKey = deriveLogicalProjectKey(sourceProject, {
    groupingMode: "repository_path",
  });
  return {
    candidates: sameRepository,
    preselected:
      sameRepository.find(
        (project) =>
          deriveLogicalProjectKey(project, { groupingMode: "repository_path" }) === sourcePathKey,
      ) ?? (sameRepository.length === 1 ? sameRepository[0]! : null),
  };
}

/** The target project that is the same repository, or null. */
function matchTargetProject(
  sourceProject: AgentMoveProject,
  targetProjects: ReadonlyArray<AgentMoveProject>,
): AgentMoveProject | null {
  return matchTargetProjects(sourceProject, targetProjects).preselected;
}

// Key order differs between decoders, so compare values instead of serialized text.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export function planAgentMove(input: AgentMoveInput): AgentMovePlan {
  const { source } = input;
  const existing = input.targetAgents.find((agent) => agent.profile.id === source.profile.id);
  const notes: AgentMoveNote[] = [];

  let projectKey = "";
  if (source.profile.projectKey) {
    const parsed = parseProjectKey(source.profile.projectKey);
    const sourceProject = parsed
      ? input.sourceProjects.find((p) => p.environmentId === parsed[0] && p.id === parsed[1])
      : undefined;
    const match = sourceProject ? matchTargetProject(sourceProject, input.targetProjects) : null;
    if (match) projectKey = JSON.stringify([match.environmentId, match.id]);
    else notes.push("project_missing");
  }

  let modelSelection = source.profile.modelSelection;
  if (modelSelection) {
    const provider = input.targetProviders.find((p) => p.instanceId === modelSelection!.instanceId);
    if (!provider) {
      notes.push("machine_only_model");
      modelSelection = null;
    } else if (
      !provider.enabled ||
      (provider.models !== undefined &&
        !provider.models.some((model) => model.slug === modelSelection!.model))
    ) {
      notes.push("model_unavailable");
      modelSelection = null;
    }
  }

  const archiveDiffers = existing !== undefined && !sameValue(existing.archive, source.archive);
  if (archiveDiffers) notes.push("archive_differs");

  const verdict: AgentMoveVerdict = {
    agentId: source.profile.id,
    name: source.profile.name,
    mode: existing ? "merge" : "create",
    notes,
    messages: notes.length
      ? notes.map((note) => AGENT_MOVE_MESSAGES[note])
      : [AGENT_MOVE_MESSAGES.willMove],
    blocked: archiveDiffers,
    stayByDefault: notes.includes("machine_only_model"),
  };
  if (archiveDiffers) return { verdict, record: null, expectedRevision: existing.revision };

  const profile = { ...source.profile, projectKey, modelSelection };
  // The source's profile, memories, recovery and archive win; the target keeps its own
  // conversation links and revision so no thread ends up owned by two agents.
  const record: WorkspaceAgent = existing
    ? {
        ...existing,
        profile,
        memories: source.memories,
        recovery: source.recovery,
        archive: source.archive,
        archivedAt: null,
        updatedAt: source.updatedAt,
      }
    : {
        profile,
        revision: 0,
        archive: source.archive,
        recovery: source.recovery,
        memories: source.memories,
        primaryThreadId: null,
        threadIds: [],
        archivedAt: null,
        updatedAt: source.updatedAt,
      };
  return { verdict, record, expectedRevision: existing ? existing.revision : 0 };
}

/** Plans every active agent on the source; archived agents stay where they are. */
export function planAgentMoves(
  input: Omit<AgentMoveInput, "source"> & { readonly sourceAgents: ReadonlyArray<WorkspaceAgent> },
): ReadonlyArray<AgentMovePlan> {
  const { sourceAgents, ...rest } = input;
  return sourceAgents
    .filter((agent) => !agent.archivedAt)
    .map((source) => planAgentMove({ ...rest, source }));
}

/** Plain sentence for a failed save on the target, from the raw RPC error. */
export function describeAgentMoveFailure(error: unknown): string {
  const tag =
    typeof error === "object" && error !== null ? (error as { _tag?: unknown })._tag : undefined;
  const reason =
    typeof error === "object" && error !== null
      ? (error as { reason?: unknown }).reason
      : undefined;
  if (tag === "AgentWorkspaceError") {
    switch (reason) {
      case "conflict":
        return "The target changed this agent in the meantime, or another agent there already owns one of its conversations. Refresh and try again.";
      case "invalid_import":
        return "The target rejected this agent's data, so nothing was saved.";
      case "storage":
        return "The target could not read or write its agent storage right now.";
      case "recovery_required":
        return "This agent's recovery has not been confirmed, so the target would not save it. Confirm it first.";
      default:
        return "The target could not find or save this agent.";
    }
  }
  if (tag === "EnvironmentAuthorizationError")
    return "You are not allowed to change agents on the target.";
  return "The target could not save this agent.";
}
