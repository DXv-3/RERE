import {
  THREAD_TRANSFER_MAX_MESSAGES,
  type ModelSelection,
  type ProjectId,
  type RepositoryIdentity,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadId,
  type ThreadTransferExport,
  type ThreadTransferImportInput,
  type ThreadTransferImportResult,
  type ThreadTransferMessage,
  type ThreadTransferWorkspace,
} from "@t3tools/contracts";

import type { ThreadRuntimeSummary } from "../state/models.ts";
import { matchTargetProjects, type AgentMoveProject } from "./agentMove.ts";

/**
 * Continue On hands a thread to another environment: read an export from the source, write an
 * import to the target, then settle the source thread. The client sits between two servers that
 * never talk to each other, so everything here is shared by web and mobile and the caller owns
 * the network calls (see `ContinueOnPorts`).
 */

/**
 * The server refuses to export a thread whose run has not finished. A run waiting on the user is
 * past the provider's work and still exports, so it does not count.
 */
export function threadIsBusyForTransfer(
  runtime: Pick<ThreadRuntimeSummary, "status"> | null | undefined,
): boolean {
  const status = runtime?.status;
  return (
    status === "preparing" || status === "queued" || status === "starting" || status === "running"
  );
}

// -- Working tree ----------------------------------------------------------------------------

export interface TransferWorkspaceState {
  /** The single state to present; uncommitted files outrank unpushed commits. */
  readonly kind: "not_a_repository" | "clean" | "unpushed" | "uncommitted";
  readonly hasUncommitted: boolean;
  /** Commits (or a whole branch) the target cannot fetch. True when it cannot be verified. */
  readonly hasUnpushed: boolean;
  /** Pushing needs a branch, and the default branch is never pushed from here without asking. */
  readonly canPush: boolean;
  /** Continuing leaves work behind, so the user must opt in to "conversation only". */
  readonly needsAcknowledgement: boolean;
}

export function describeTransferWorkspace(
  workspace: ThreadTransferWorkspace,
): TransferWorkspaceState {
  if (!workspace.isRepo) {
    return {
      kind: "not_a_repository",
      hasUncommitted: false,
      hasUnpushed: false,
      canPush: false,
      needsAcknowledgement: false,
    };
  }
  const hasUncommitted = workspace.hasWorkingTreeChanges;
  const hasUnpushed =
    workspace.branch === null || !workspace.hasUpstream || workspace.aheadCount > 0;
  return {
    kind: hasUncommitted ? "uncommitted" : hasUnpushed ? "unpushed" : "clean",
    hasUncommitted,
    hasUnpushed,
    canPush: workspace.branch !== null && !workspace.isDefaultBranch,
    needsAcknowledgement: hasUncommitted || hasUnpushed,
  };
}

// -- Target project --------------------------------------------------------------------------

export interface TransferProjectPlan<Project extends AgentMoveProject> {
  /** Target projects for the same repository. */
  readonly candidates: ReadonlyArray<Project>;
  /** Chosen for the user when exactly one project clearly matches; otherwise they choose. */
  readonly preselected: Project | null;
  /** The target's personal workspace (`projects.ensureScratch`) is always an option. */
  readonly scratchAvailable: true;
}

/**
 * Finds the target project for the thread's repository. The source project is matched by the
 * repository identity the source server exported, falling back to what the client knows of it.
 */
export function planTransferProject<Project extends AgentMoveProject>(input: {
  readonly sourceProject: AgentMoveProject;
  readonly exportedIdentity: RepositoryIdentity | null;
  readonly targetProjects: ReadonlyArray<Project>;
}): TransferProjectPlan<Project> {
  const matched = matchTargetProjects(
    {
      ...input.sourceProject,
      repositoryIdentity: input.exportedIdentity ?? input.sourceProject.repositoryIdentity ?? null,
    },
    input.targetProjects,
  );
  return { ...matched, scratchAvailable: true };
}

// -- Model -----------------------------------------------------------------------------------

export type TransferTargetProvider = Pick<
  ServerProvider,
  "instanceId" | "enabled" | "availability"
> & {
  readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom" | "isDefault">>;
};

export interface TransferModelChoice {
  /** Null when the target has no enabled provider with a model to run the thread on. */
  readonly selection: ModelSelection | null;
  readonly origin: "same_instance" | "target_default" | "none";
}

const isUsable = (provider: TransferTargetProvider) =>
  provider.enabled && provider.availability !== "unavailable";

function defaultModelOf(provider: TransferTargetProvider): string | null {
  return (
    provider.models.find((model) => model.isDefault === true && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug ??
    null
  );
}

/**
 * Keeps the source's model selection when the same provider instance is enabled on the target.
 * Otherwise uses the target's default: the project's own default when its instance is usable,
 * else the first usable provider's default model.
 */
export function pickTransferModel(input: {
  readonly source: ModelSelection;
  readonly targetProviders: ReadonlyArray<TransferTargetProvider>;
  readonly targetProjectDefault: ModelSelection | null;
}): TransferModelChoice {
  const usable = input.targetProviders.filter(isUsable);
  // Two machines can share an instance id and still offer different models.
  const sameInstance = usable.find((provider) => provider.instanceId === input.source.instanceId);
  if (
    sameInstance &&
    (sameInstance.models.length === 0 ||
      sameInstance.models.some((model) => model.slug === input.source.model))
  ) {
    return { selection: input.source, origin: "same_instance" };
  }
  const projectDefault = input.targetProjectDefault;
  if (projectDefault !== null && usable.some((p) => p.instanceId === projectDefault.instanceId)) {
    return { selection: projectDefault, origin: "target_default" };
  }
  for (const provider of usable) {
    const model = defaultModelOf(provider);
    if (model !== null) {
      return {
        selection: { instanceId: provider.instanceId, model },
        origin: "target_default",
      };
    }
  }
  return { selection: null, origin: "none" };
}

// -- Message cap and note --------------------------------------------------------------------

/**
 * Applies the message-count limit up front so the note can state what was left out. The server
 * enforces the same count and a byte limit, and states anything further it drops itself.
 */
export function limitTransferMessages(messages: ReadonlyArray<ThreadTransferMessage>): {
  readonly messages: ReadonlyArray<ThreadTransferMessage>;
  readonly omittedCount: number;
} {
  const omittedCount = Math.max(0, messages.length - THREAD_TRANSFER_MAX_MESSAGES);
  return { messages: messages.slice(omittedCount), omittedCount };
}

const NOTE_FILE_LIMIT = 20;

/**
 * The final message of the imported thread. The model reads it on the first turn, so it states
 * where the work was and what did not come along, in plain terms.
 */
export function buildTransferNote(input: {
  readonly sourceEnvironmentLabel: string;
  readonly workspace: ThreadTransferWorkspace;
  readonly omittedCount: number;
}): string {
  const { workspace } = input;
  const state = describeTransferWorkspace(workspace);
  const lines = [
    `This conversation was continued from another environment (${input.sourceEnvironmentLabel}). The messages above are its transcript. Tool calls, command output and attachments were not carried over, and file paths mentioned earlier refer to that machine's files, which may not exist here.`,
  ];
  if (input.omittedCount > 0) {
    lines.push(
      `${input.omittedCount} earlier message${input.omittedCount === 1 ? " was" : "s were"} left out because the conversation was too long to carry over.`,
    );
  }
  if (state.kind === "not_a_repository") {
    lines.push("The thread's folder there is not a git repository, so there is no code to fetch.");
    return lines.join("\n\n");
  }
  const at = workspace.headSha === null ? "" : ` at commit ${workspace.headSha}`;
  if (workspace.branch === null) {
    lines.push(`The work was on a detached HEAD${at}.`);
  } else {
    lines.push(
      `The work was on branch ${workspace.branch}${at}. Fetch that branch to get the code.`,
    );
  }
  if (state.hasUnpushed) {
    lines.push(
      workspace.branch !== null && !workspace.hasUpstream
        ? "That branch was never pushed, so its commits are not available here."
        : workspace.aheadCount > 0
          ? `${workspace.aheadCount} commit${workspace.aheadCount === 1 ? "" : "s"} on that branch had not been pushed, so ${workspace.aheadCount === 1 ? "it is" : "they are"} not available here.`
          : "Whether that commit was pushed could not be confirmed, so it may not be available here.",
    );
  }
  if (state.hasUncommitted) {
    const shown = workspace.changedFiles.slice(0, NOTE_FILE_LIMIT);
    const rest = workspace.changedFiles.length - shown.length;
    lines.push(
      [
        `Uncommitted changes (${workspace.changedFiles.length} file${workspace.changedFiles.length === 1 ? "" : "s"}) stayed on the other machine and are not available here:`,
        ...shown.map((path) => `- ${path}`),
        ...(rest > 0 ? [`- and ${rest} more`] : []),
      ].join("\n"),
    );
  }
  return lines.join("\n\n");
}

// -- Running the handoff ---------------------------------------------------------------------

export type TransferTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  | { readonly kind: "scratch" };

/** The network calls the handoff needs, bound by the caller to the right environments. */
export interface ContinueOnPorts {
  readonly ensureScratch: () => Promise<ProjectId>;
  readonly importThread: (input: ThreadTransferImportInput) => Promise<ThreadTransferImportResult>;
  /** Settles the source thread (reversible). */
  readonly settleSource: () => Promise<void>;
}

export interface ContinueOnResult {
  readonly targetThreadId: ThreadId;
  /** Set when the import succeeded but the source thread could not be settled. */
  readonly settleError: unknown | null;
  readonly result: ThreadTransferImportResult;
}

/**
 * Imports into the target, then settles the source. A failed import throws and leaves the source
 * untouched. A failed settle does not undo the import: the target thread exists, so the caller
 * should warn and still navigate to it.
 */
export async function executeContinueOn(input: {
  readonly ports: ContinueOnPorts;
  readonly transferId: string;
  readonly exported: ThreadTransferExport;
  readonly target: TransferTarget;
  readonly modelSelection: ModelSelection;
  readonly sourceEnvironmentLabel: string;
}): Promise<ContinueOnResult> {
  const { exported, ports } = input;
  const projectId =
    input.target.kind === "scratch" ? await ports.ensureScratch() : input.target.projectId;
  const limited = limitTransferMessages(exported.messages);
  const result = await ports.importThread({
    transferId: input.transferId,
    projectId,
    title: exported.title,
    modelSelection: input.modelSelection,
    runtimeMode: exported.runtimeMode,
    interactionMode: exported.interactionMode,
    // The target's checkout is not on the source's branch; the note says which one to fetch.
    branch: null,
    worktreePath: null,
    messages: limited.messages,
    note: buildTransferNote({
      sourceEnvironmentLabel: input.sourceEnvironmentLabel,
      workspace: exported.workspace,
      omittedCount: limited.omittedCount,
    }),
  });
  const settleError = await ports.settleSource().then(
    () => null,
    (error: unknown) => error ?? new Error("Could not settle the source thread."),
  );
  return { targetThreadId: result.threadId, settleError, result };
}
