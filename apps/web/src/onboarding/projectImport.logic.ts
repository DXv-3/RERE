import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type {
  AgentSessionImportResult,
  AgentSessionImportSkipReason,
  AgentSessionProjectCandidate,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** One or two threads in a directory is usually a one-off question, not a project. */
const DEFAULT_SELECTION_MIN_THREADS = 3;

/**
 * Existing projects still need their agent history imported, so every scan
 * candidate is offered. The default selection is narrower: git repositories
 * active in the last 30 days with enough threads to look like real work.
 * Servers that predate the git scan omit `git`; their candidates are treated
 * as repositories so old computers still get a useful default selection.
 */
export function partitionOnboardingProjects<T extends AgentSessionProjectCandidate>(
  candidates: ReadonlyArray<T>,
  now = Date.now(),
) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available: candidates,
    recent: candidates.filter((candidate) => {
      if (candidate.git === null) return false;
      if (candidate.threadCount < DEFAULT_SELECTION_MIN_THREADS) return false;
      if (candidate.lastActiveAt === null) return false;
      const lastActiveAt = Date.parse(candidate.lastActiveAt);
      return lastActiveAt >= cutoff && lastActiveAt <= now;
    }),
  };
}

export interface OnboardingProjectGroup<T> {
  /** Stable identity for collapse state and React keys. */
  readonly key: string;
  /** GitHub `owner/name`, or the checkout's folder name when the origin is elsewhere. */
  readonly label: string;
  readonly repository: string | null;
  readonly candidates: ReadonlyArray<T>;
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

function latestActivity(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * Group scan candidates for the onboarding picker. Clones of one repository
 * share a group keyed by their normalized origin URL. Repositories without an
 * origin get a group each, as do candidates from servers that do not report
 * git identity. Directories that are not git repositories are returned
 * separately so the UI can fold them away by default. Groups sort by most
 * recent activity, newest first.
 */
export function groupOnboardingProjects<
  T extends Pick<
    AgentSessionProjectCandidate,
    "path" | "title" | "git" | "threadCount" | "lastActiveAt"
  >,
>(candidates: ReadonlyArray<T>) {
  const groups = new Map<string, OnboardingProjectGroup<T> & { candidates: Array<T> }>();
  const other: Array<T> = [];

  for (const candidate of candidates) {
    if (candidate.git === null) {
      other.push(candidate);
      continue;
    }
    const git = candidate.git ?? { remoteKey: null, repository: null };
    const key = git.remoteKey === null ? `path:${candidate.path}` : `remote:${git.remoteKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        label: git.repository ?? candidate.title,
        repository: git.repository,
        candidates: [candidate],
        threadCount: candidate.threadCount,
        lastActiveAt: candidate.lastActiveAt,
      });
      continue;
    }
    existing.candidates.push(candidate);
    groups.set(key, {
      ...existing,
      threadCount: existing.threadCount + candidate.threadCount,
      lastActiveAt: latestActivity(existing.lastActiveAt, candidate.lastActiveAt),
    });
  }

  const repositories = [...groups.values()].sort((left, right) => {
    if (left.lastActiveAt === right.lastActiveAt) return left.label.localeCompare(right.label);
    if (left.lastActiveAt === null) return 1;
    if (right.lastActiveAt === null) return -1;
    return right.lastActiveAt.localeCompare(left.lastActiveAt);
  });

  return { repositories, other };
}

/** Use the server's project match before the client snapshot, which can lag behind the scan. */
export function resolveOnboardingProjectId(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
  environmentId: EnvironmentId,
  candidate: Pick<AgentSessionProjectCandidate, "path" | "projectId">,
): ProjectId | null {
  if (candidate.projectId !== undefined) return candidate.projectId;
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const currentRootMatch = findProjectByPath(environmentProjects, candidate.path);
  if (currentRootMatch !== undefined) return currentRootMatch.id;
  return null;
}

/** Prefer a selected project with imported history, then a completed empty import. */
export function resolveOnboardingLandingProject<T>(
  selection: ReadonlyArray<string>,
  projectsWithImportedHistory: ReadonlyMap<string, T>,
  completedProjects: ReadonlyMap<string, T>,
): T | undefined {
  for (const path of selection) {
    const project = projectsWithImportedHistory.get(path);
    if (project !== undefined) return project;
  }
  for (const path of selection) {
    const project = completedProjects.get(path);
    if (project !== undefined) return project;
  }
  return undefined;
}

/** Paths identify projects only within the computer that owns them. */
export function onboardingProjectKey(environmentId: EnvironmentId, path: string): string {
  return JSON.stringify([environmentId, path]);
}

const IMPORT_SKIP_EXPLANATIONS: Record<AgentSessionImportSkipReason, string> = {
  "import-limit": "reached this import’s limit; retry to continue with the remaining history",
  "history-too-large": "exceeded the maximum history file size",
  "unreadable-history":
    "could not be read safely; check file access and retry after the session is idle (large or malformed history may also exceed the reading limit)",
  "invalid-history": "had no usable conversation or project metadata",
  "project-changed": "no longer matched the selected project; scan for projects again",
  "not-resumable": "had no supported session ID for resuming",
  "project-conflict": "already belonged to another project; the existing sessions were preserved",
  "modified-history": "had changed since import; the existing sessions were preserved",
  "import-failed": "could not be saved; retry the import",
};

/** Older servers only report counts, so preserve their existing warning. */
export function describeImportSkips(reasons: AgentSessionImportResult["skippedReasons"]): string {
  const counts = new Map<AgentSessionImportSkipReason, number>();
  for (const { reason, count } of reasons ?? []) {
    if (count > 0) counts.set(reason, (counts.get(reason) ?? 0) + count);
  }
  return [...counts]
    .map(([reason, count]) => `${count} ${IMPORT_SKIP_EXPLANATIONS[reason]}.`)
    .join(" ");
}
