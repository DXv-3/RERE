import type {
  ModelSelection,
  ProjectId,
  ThreadTransferExport,
  ThreadTransferImportInput,
  ThreadTransferImportResult,
  WorkspaceAgent,
} from "@t3tools/contracts";

import { buildTransferNote, limitTransferMessages } from "./threadTransfer.ts";

/**
 * Keeps an agent's conversation available on both environments. One side holds the live
 * conversation; the other holds a copy that is extended after each turn, so a device that only
 * reaches the other environment finds it current. A copy that gets a turn of its own becomes the
 * live one, and the old live thread stays in the agent's history. The client sits between two
 * servers that never talk to each other, so the caller owns the network calls.
 */

export type ConversationSide = "local" | "remote";
const otherSide = (side: ConversationSide): ConversationSide =>
  side === "local" ? "remote" : "local";

/** What the client remembers about an agent's copy between passes. Stored as JSON. */
export interface ConversationCopyState {
  readonly liveSide: ConversationSide;
  readonly liveThreadId: string;
  /** Messages of the live thread already in the copy. */
  readonly copiedCount: number;
  readonly copyThreadId: string;
  /** Messages the copy holds, which the server checks before extending it. */
  readonly copyMessageCount: number;
}

/**
 * Where each agent's live conversation was when this client last synced. A client knows this
 * from its stored state before the first pass of a session finishes, which is when it matters:
 * opening an agent straight after launch must land on the live thread, not on the local copy,
 * or the next message runs on the wrong environment and turns the copy into the live one.
 */
export function liveConversationsFromStored<EnvironmentId>(
  copies: Readonly<Record<string, ConversationCopyState>>,
  environmentOf: (side: ConversationSide) => EnvironmentId,
): Record<string, { environmentId: EnvironmentId; threadId: string }> {
  const live: Record<string, { environmentId: EnvironmentId; threadId: string }> = {};
  for (const [agentId, state] of Object.entries(copies)) {
    if (state.liveSide !== "local" && state.liveSide !== "remote") continue;
    if (typeof state.liveThreadId !== "string" || state.liveThreadId === "") continue;
    live[agentId] = { environmentId: environmentOf(state.liveSide), threadId: state.liveThreadId };
  }
  return live;
}

/**
 * Whether the open thread is the copy side of some agent's conversation, and where the live one
 * is. The copy runs on whatever model this machine has and only knows the live conversation as a
 * transcript, so typing into it by accident gives a worse answer and then replaces the live side.
 */
export function findConversationCopy<EnvironmentId>(
  copies: Readonly<Record<string, ConversationCopyState>>,
  environmentOf: (side: ConversationSide) => EnvironmentId,
  open: { readonly environmentId: EnvironmentId; readonly threadId: string },
): {
  readonly agentId: string;
  readonly live: { readonly environmentId: EnvironmentId; readonly threadId: string };
} | null {
  for (const [agentId, state] of Object.entries(copies)) {
    if (state.liveSide !== "local" && state.liveSide !== "remote") continue;
    if (typeof state.liveThreadId !== "string" || state.liveThreadId === "") continue;
    if (state.copyThreadId !== open.threadId) continue;
    if (environmentOf(otherSide(state.liveSide)) !== open.environmentId) continue;
    // A thread that is both live and copy in one record is a broken record, not a copy.
    if (state.liveThreadId === open.threadId) continue;
    return {
      agentId,
      live: { environmentId: environmentOf(state.liveSide), threadId: state.liveThreadId },
    };
  }
  return null;
}

/**
 * What to do with a message typed into a thread. A copy only ever becomes the live conversation
 * on purpose: while the live side can be reached the first message asks, and once the user has
 * said "send here" in that conversation it does not ask again. With the live side offline there
 * is nothing better to open, so the message goes through (the banner still says what this is).
 */
export function decideCopySend(input: {
  readonly isCopy: boolean;
  readonly liveReachable: boolean;
  readonly confirmed: boolean;
}): "send" | "confirm" {
  return input.isCopy && input.liveReachable && !input.confirmed ? "confirm" : "send";
}

/**
 * Transfer copies of an agent's conversation that nothing points at any more: every
 * `transfer:` thread except the one the agent opens (`primaryThreadId`) and the current live and
 * copy pair. Callers pass the agent's threads on one environment; the result is what is safe to
 * archive there. Never selects a thread that was not made by a transfer.
 */
export function selectOldTransferCopies(input: {
  readonly threadIds: ReadonlyArray<string>;
  readonly primaryThreadId: string | null | undefined;
  readonly pair: Pick<ConversationCopyState, "liveThreadId" | "copyThreadId"> | null;
}): string[] {
  const keep = new Set<string>();
  if (input.primaryThreadId) keep.add(input.primaryThreadId);
  if (input.pair) {
    keep.add(input.pair.liveThreadId);
    keep.add(input.pair.copyThreadId);
  }
  return [...new Set(input.threadIds)].filter((id) => id.startsWith("transfer:") && !keep.has(id));
}

export interface ConversationPorts {
  /** "busy" while a run is in progress, null when the thread is gone or cannot be read. */
  readonly exportThread: (
    side: ConversationSide,
    input: { readonly threadId: string; readonly afterCount?: number },
  ) => Promise<ThreadTransferExport | "busy" | null>;
  readonly importThread: (
    side: ConversationSide,
    input: ThreadTransferImportInput,
  ) => Promise<ThreadTransferImportResult | null>;
  /** Where a new copy goes on that side and which model it runs on; null when it has neither. */
  readonly resolveTarget: (
    side: ConversationSide,
    agent: WorkspaceAgent,
    exported: ThreadTransferExport,
  ) => Promise<{
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
  } | null>;
  /** Makes the thread the agent's conversation on that side, keeping its earlier ones. */
  readonly attach: (
    side: ConversationSide,
    agent: WorkspaceAgent,
    threadId: string,
  ) => Promise<boolean>;
  readonly label: (side: ConversationSide) => string;
  readonly newTransferId: () => string;
}

export interface ConversationSyncResult {
  readonly state: ConversationCopyState | null;
  /** The side to open and reply on; null when the agent has no conversation yet. */
  readonly liveSide: ConversationSide | null;
  readonly outcome: "nothing" | "extended" | "copied" | "waiting" | "failed";
}

const lastMessageAt = (exported: ThreadTransferExport) =>
  Date.parse(exported.messages.at(-1)?.createdAt ?? "") || 0;
const countOf = (exported: ThreadTransferExport, skipped: number) =>
  exported.messageCount ?? skipped + exported.messages.length;

export async function syncAgentConversation(input: {
  readonly agents: Readonly<Record<ConversationSide, WorkspaceAgent>>;
  readonly state: ConversationCopyState | null;
  readonly ports: ConversationPorts;
}): Promise<ConversationSyncResult> {
  const { agents, ports } = input;
  const primary = (side: ConversationSide) => agents[side].primaryThreadId;

  /** Copies the whole live conversation to the other side as that agent's conversation. */
  const copyAcross = async (
    liveSide: ConversationSide,
    exported: ThreadTransferExport,
  ): Promise<ConversationSyncResult> => {
    const target = otherSide(liveSide);
    const resolved = await ports.resolveTarget(target, agents[target], exported);
    if (!resolved) return { state: null, liveSide, outcome: "failed" };
    const limited = limitTransferMessages(exported.messages);
    const imported = await ports.importThread(target, {
      transferId: ports.newTransferId(),
      projectId: resolved.projectId,
      title: exported.title,
      modelSelection: resolved.modelSelection,
      runtimeMode: exported.runtimeMode,
      interactionMode: exported.interactionMode,
      branch: null,
      worktreePath: null,
      messages: limited.messages,
      note: buildTransferNote({
        sourceEnvironmentLabel: ports.label(liveSide),
        workspace: exported.workspace,
        omittedCount: limited.omittedCount,
      }),
      appendFrom: 0,
    });
    if (!imported || imported.messageCount === undefined)
      return { state: null, liveSide, outcome: "failed" };
    if (!(await ports.attach(target, agents[target], imported.threadId)))
      return { state: null, liveSide, outcome: "failed" };
    return {
      state: {
        liveSide,
        liveThreadId: exported.threadId,
        copiedCount: countOf(exported, 0),
        copyThreadId: imported.threadId,
        copyMessageCount: imported.messageCount,
      },
      liveSide,
      outcome: "copied",
    };
  };

  const { state } = input;
  const paired =
    state !== null &&
    primary(state.liveSide) === state.liveThreadId &&
    primary(otherSide(state.liveSide)) === state.copyThreadId;

  if (paired) {
    const copySide = otherSide(state.liveSide);
    const fresh = await ports.exportThread(state.liveSide, {
      threadId: state.liveThreadId,
      afterCount: state.copiedCount,
    });
    if (fresh === "busy") return { state, liveSide: state.liveSide, outcome: "waiting" };
    if (fresh !== null) {
      // An older server ignores `afterCount` and returns the whole transcript.
      const added =
        fresh.messageCount === undefined ? fresh.messages.slice(state.copiedCount) : fresh.messages;
      const extended = await ports.importThread(copySide, {
        transferId: state.copyThreadId.replace(/^transfer:/, ""),
        projectId: fresh.projectId,
        title: fresh.title,
        modelSelection: fresh.modelSelection,
        runtimeMode: fresh.runtimeMode,
        interactionMode: fresh.interactionMode,
        branch: null,
        worktreePath: null,
        messages: added,
        note: "",
        appendFrom: state.copyMessageCount,
      });
      if (!extended) return { state, liveSide: state.liveSide, outcome: "failed" };
      if (extended.appendable && extended.messageCount !== undefined) {
        return {
          state: {
            ...state,
            copiedCount: state.copiedCount + added.length,
            copyMessageCount: extended.messageCount,
          },
          liveSide: state.liveSide,
          outcome: added.length > 0 ? "extended" : "nothing",
        };
      }
      // The copy was replied to. It is the live one unless the old live thread moved on later.
      const copy = await ports.exportThread(copySide, { threadId: state.copyThreadId });
      if (copy === "busy") return { state, liveSide: copySide, outcome: "waiting" };
      if (copy !== null) {
        if (added.length === 0 || lastMessageAt(copy) >= lastMessageAt(fresh))
          return copyAcross(copySide, copy);
        const whole = await ports.exportThread(state.liveSide, { threadId: state.liveThreadId });
        if (whole === "busy") return { state, liveSide: state.liveSide, outcome: "waiting" };
        if (whole !== null) return copyAcross(state.liveSide, whole);
      }
      return { state, liveSide: state.liveSide, outcome: "failed" };
    }
  }

  // No usable pairing: read whichever conversations exist and copy the newer one across.
  const read = async (side: ConversationSide) => {
    const threadId = primary(side);
    return threadId ? ports.exportThread(side, { threadId }) : null;
  };
  const [local, remote] = await Promise.all([read("local"), read("remote")]);
  if (local === "busy" || remote === "busy") {
    return { state: null, liveSide: local === "busy" ? "local" : "remote", outcome: "waiting" };
  }
  // A conversation nobody has written in is not worth a thread on the other side.
  const written = (exported: ThreadTransferExport | null) =>
    exported !== null && exported.messages.length > 0;
  if (!written(local) && !written(remote)) {
    return {
      state: null,
      liveSide: local ? "local" : remote ? "remote" : null,
      outcome: "nothing",
    };
  }
  if (written(local) && (!written(remote) || lastMessageAt(local!) >= lastMessageAt(remote!)))
    return copyAcross("local", local!);
  return copyAcross("remote", remote!);
}
