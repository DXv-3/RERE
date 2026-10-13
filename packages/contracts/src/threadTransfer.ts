import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Handing a thread to another environment (Continue On). The client reads an export from the
 * source environment and writes an import to the target; the two servers never talk to each
 * other. Only the visible transcript travels, as imported history with no turn started.
 */

/** Largest import the target accepts. The newest messages are kept past either limit. */
export const THREAD_TRANSFER_MAX_MESSAGES = 5_000;
export const THREAD_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;

const THREAD_TRANSFER_MAX_NOTE_CHARS = 50_000;

/** Stands in for an attachment, which does not travel. */
export const THREAD_TRANSFER_ATTACHMENT_PLACEHOLDER = "[attachment not carried over]";

/** The client picks this once per handoff; a retry reuses it so the import stays idempotent. */
export const ThreadTransferId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);
export type ThreadTransferId = typeof ThreadTransferId.Type;

export const ThreadTransferMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadTransferMessage = typeof ThreadTransferMessage.Type;

/** Git facts about where the thread's work lives, as seen from the source machine. */
export const ThreadTransferWorkspace = Schema.Struct({
  cwd: Schema.NullOr(Schema.String),
  isRepo: Schema.Boolean,
  branch: Schema.NullOr(Schema.String),
  /** The branch is the repository's default one; clients do not push it without asking. */
  isDefaultBranch: Schema.Boolean,
  headSha: Schema.NullOr(Schema.String),
  hasWorkingTreeChanges: Schema.Boolean,
  changedFiles: Schema.Array(Schema.String),
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
});
export type ThreadTransferWorkspace = typeof ThreadTransferWorkspace.Type;

export const ThreadTransferExportInput = Schema.Struct({
  threadId: ThreadId,
  /** Leave out this many of the oldest messages; a running copy only needs what is new. */
  afterCount: Schema.optional(NonNegativeInt),
});
export type ThreadTransferExportInput = typeof ThreadTransferExportInput.Type;

export const ThreadTransferExport = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  messages: Schema.Array(ThreadTransferMessage),
  /** Messages in the whole transcript, including any left out by `afterCount`. */
  messageCount: Schema.optional(NonNegativeInt),
  workspace: ThreadTransferWorkspace,
});
export type ThreadTransferExport = typeof ThreadTransferExport.Type;

export const ThreadTransferImportInput = Schema.Struct({
  transferId: ThreadTransferId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ThreadTransferMessage),
  /** Appended as the final assistant message so the model reads where the work stands. */
  note: Schema.String.check(Schema.isMaxLength(THREAD_TRANSFER_MAX_NOTE_CHARS)),
  /**
   * Extends a thread this transfer already created instead of leaving it as it is. It must equal
   * the `messageCount` the last import returned, and an empty note is not written.
   */
  appendFrom: Schema.optional(NonNegativeInt),
});
export type ThreadTransferImportInput = typeof ThreadTransferImportInput.Type;

export const ThreadTransferImportResult = Schema.Struct({
  threadId: ThreadId,
  /** True when this transfer had already been imported and nothing was written. */
  alreadyImported: Schema.Boolean,
  importedMessageCount: NonNegativeInt,
  /** Oldest messages dropped to stay within the limits. */
  omittedMessageCount: NonNegativeInt,
  /** Messages the target thread holds after this import. */
  messageCount: Schema.optional(NonNegativeInt),
  /**
   * False once the target thread has had turns of its own or no longer matches `appendFrom`.
   * Nothing was written; the caller starts a new transfer instead.
   */
  appendable: Schema.optional(Schema.Boolean),
});
export type ThreadTransferImportResult = typeof ThreadTransferImportResult.Type;

export const ThreadTransferErrorReason = Schema.Literals([
  "thread_not_found",
  "run_in_progress",
  "project_not_found",
  "failed",
]);
export type ThreadTransferErrorReason = typeof ThreadTransferErrorReason.Type;

export class ThreadTransferError extends Schema.TaggedError<ThreadTransferError>()(
  "ThreadTransferError",
  {
    reason: ThreadTransferErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread_not_found":
        return "The thread to continue was not found.";
      case "run_in_progress":
        return "The thread is still working. Wait for it to finish before continuing it elsewhere.";
      case "project_not_found":
        return "The project to continue in was not found on the target.";
      case "failed":
        return "Could not hand the thread over.";
    }
  }
}
