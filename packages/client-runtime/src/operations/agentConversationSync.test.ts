import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadTransferExport,
  type ThreadTransferMessage,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  syncAgentConversation,
  decideCopySend,
  findConversationCopy,
  selectOldTransferCopies,
  type ConversationCopyState,
  type ConversationPorts,
  type ConversationSide,
  liveConversationsFromStored,
} from "./agentConversationSync.ts";

interface FakeThread {
  messages: ThreadTransferMessage[];
  /** Set once the thread has had a turn of its own, which ends extending it. */
  hasRuns: boolean;
  busy: boolean;
}

const message = (text: string, minute: number): ThreadTransferMessage => ({
  role: minute % 2 === 1 ? "user" : "assistant",
  text,
  createdAt: `2026-10-04T12:${String(minute).padStart(2, "0")}:00.000Z`,
});

function agent(primaryThreadId: string | null): WorkspaceAgent {
  return {
    profile: {
      id: "a",
      name: "Agent",
      description: "",
      instructions: "",
      color: "#22c55e",
      pinned: true,
      projectKey: "",
      runtimeMode: "inherit",
      modelSelection: null,
    },
    revision: 1,
    archive: null,
    recovery: { disposition: "ready", summary: "ok", blockers: [], verifiedAt: null, evidence: [] },
    memories: [],
    primaryThreadId,
    threadIds: primaryThreadId ? [primaryThreadId] : [],
    updatedAt: "2026-10-04T10:00:00.000Z",
  };
}

/** Two environments with the server's append rules, driven through the ports. */
function world(localPrimary: string | null, remotePrimary: string | null) {
  const threads: Record<ConversationSide, Map<string, FakeThread>> = {
    local: new Map(),
    remote: new Map(),
  };
  const agents = { local: agent(localPrimary), remote: agent(remotePrimary) };
  let transfers = 0;
  let state: ConversationCopyState | null = null;
  const ports: ConversationPorts = {
    exportThread: async (side, input) => {
      const thread = threads[side].get(input.threadId);
      if (!thread) return null;
      if (thread.busy) return "busy";
      return {
        threadId: ThreadId.make(input.threadId),
        projectId: ProjectId.make("project"),
        title: "Conversation",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
        runtimeMode: "full-access",
        interactionMode: "default",
        repositoryIdentity: null,
        messages: thread.messages.slice(input.afterCount ?? 0),
        messageCount: thread.messages.length,
        workspace: {
          cwd: null,
          isRepo: false,
          branch: null,
          isDefaultBranch: false,
          headSha: null,
          hasWorkingTreeChanges: false,
          changedFiles: [],
          hasUpstream: false,
          aheadCount: 0,
        },
      } satisfies ThreadTransferExport;
    },
    importThread: async (side, input) => {
      const threadId = ThreadId.make(`transfer:${input.transferId}`);
      const existing = threads[side].get(threadId);
      const note = input.note
        ? [
            {
              role: "assistant" as const,
              text: "NOTE",
              createdAt: input.messages.at(-1)!.createdAt,
            },
          ]
        : [];
      const result = { threadId, importedMessageCount: 0, omittedMessageCount: 0 };
      if (!existing) {
        threads[side].set(threadId, {
          messages: [...input.messages, ...note],
          hasRuns: false,
          busy: false,
        });
        return {
          ...result,
          alreadyImported: false,
          messageCount: input.messages.length + note.length,
          appendable: true,
        };
      }
      const appendable = !existing.hasRuns && existing.messages.length === input.appendFrom;
      if (appendable) existing.messages.push(...input.messages, ...note);
      return {
        ...result,
        alreadyImported: true,
        messageCount: existing.messages.length,
        appendable,
      };
    },
    resolveTarget: async () => ({
      projectId: ProjectId.make("project"),
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
    }),
    attach: async (side, record, threadId) => {
      agents[side] = {
        ...record,
        primaryThreadId: threadId,
        threadIds: [...new Set([...(record.threadIds ?? []), threadId])],
      };
      return true;
    },
    label: (side) => (side === "local" ? "Mac" : "Server"),
    newTransferId: () => `t${(transfers += 1)}`,
  };
  const sync = async () => {
    const result = await syncAgentConversation({ agents, state, ports });
    state = result.state ?? state;
    return result;
  };
  const texts = (side: ConversationSide) =>
    threads[side].get(agents[side].primaryThreadId!)!.messages.map((m) => m.text);
  /** A turn run on that side's current conversation. */
  const reply = (side: ConversationSide, ...added: ThreadTransferMessage[]) => {
    const thread = threads[side].get(agents[side].primaryThreadId!)!;
    thread.messages.push(...added);
    thread.hasRuns = true;
  };
  return { threads, agents, sync, texts, reply };
}

describe("syncAgentConversation", () => {
  it("copies the conversation once, then only extends the copy", async () => {
    const w = world("mac-thread", null);
    w.threads.local.set("mac-thread", {
      messages: [message("hi", 1), message("hello", 2)],
      hasRuns: true,
      busy: false,
    });

    expect(await w.sync()).toMatchObject({ outcome: "copied", liveSide: "local" });
    expect(w.texts("remote")).toEqual(["hi", "hello", "NOTE"]);
    expect(await w.sync()).toMatchObject({ outcome: "nothing", liveSide: "local" });

    w.reply("local", message("more", 3), message("sure", 4));
    expect(await w.sync()).toMatchObject({ outcome: "extended" });
    expect(w.texts("remote")).toEqual(["hi", "hello", "NOTE", "more", "sure"]);
    expect(w.threads.remote.size).toBe(1);
  });

  it("follows the conversation to the other side when the copy is replied to", async () => {
    const w = world("mac-thread", null);
    w.threads.local.set("mac-thread", {
      messages: [message("hi", 1), message("hello", 2)],
      hasRuns: true,
      busy: false,
    });
    await w.sync();
    w.reply("remote", message("from the phone", 5), message("done", 6));

    expect(await w.sync()).toMatchObject({ outcome: "copied", liveSide: "remote" });
    expect(w.texts("local")).toEqual(["hi", "hello", "NOTE", "from the phone", "done", "NOTE"]);
    // The old Mac conversation is kept in the agent's history.
    expect(w.agents.local.threadIds).toContain("mac-thread");
    expect(await w.sync()).toMatchObject({ outcome: "nothing", liveSide: "remote" });
  });

  it("keeps both when each side moved on, and the newest becomes the conversation", async () => {
    const w = world("mac-thread", null);
    w.threads.local.set("mac-thread", {
      messages: [message("hi", 1), message("hello", 2)],
      hasRuns: true,
      busy: false,
    });
    await w.sync();
    const serverCopy = w.agents.remote.primaryThreadId!;
    w.reply("remote", message("phone", 5), message("ok", 6));
    w.reply("local", message("mac, later", 7), message("ok", 8));

    expect(await w.sync()).toMatchObject({ outcome: "copied", liveSide: "local" });
    expect(w.texts("remote").slice(0, 4)).toEqual(["hi", "hello", "mac, later", "ok"]);
    expect(w.agents.remote.threadIds).toContain(serverCopy);
    expect(w.threads.remote.get(serverCopy)!.messages.map((m) => m.text)).toContain("phone");
  });

  it("waits while the live conversation is still working", async () => {
    const w = world("mac-thread", null);
    w.threads.local.set("mac-thread", { messages: [message("hi", 1)], hasRuns: true, busy: true });

    expect(await w.sync()).toMatchObject({ outcome: "waiting", liveSide: "local" });
    expect(w.threads.remote.size).toBe(0);
  });

  it("does not copy a conversation nobody has written in", async () => {
    const w = world(null, "server-thread");
    w.threads.remote.set("server-thread", { messages: [], hasRuns: false, busy: false });

    expect(await w.sync()).toMatchObject({ outcome: "nothing", liveSide: "remote" });
    expect(w.threads.local.size).toBe(0);
    expect(w.agents.local.primaryThreadId).toBeNull();
  });

  it("starts from the newer conversation when both sides already have one", async () => {
    const w = world("mac-thread", "server-thread");
    w.threads.local.set("mac-thread", {
      messages: [message("old", 1)],
      hasRuns: true,
      busy: false,
    });
    w.threads.remote.set("server-thread", {
      messages: [message("old", 1), message("newer", 4)],
      hasRuns: true,
      busy: false,
    });

    expect(await w.sync()).toMatchObject({ outcome: "copied", liveSide: "remote" });
    expect(w.texts("local")).toEqual(["old", "newer", "NOTE"]);
    expect(w.agents.local.threadIds).toContain("mac-thread");
  });
});

describe("liveConversationsFromStored", () => {
  const environmentOf = (side: "local" | "remote") => (side === "local" ? "mac" : "server");
  const copy = { copiedCount: 4, copyThreadId: "transfer:copy", copyMessageCount: 4 };

  it("points each agent at the environment that held its live conversation", () => {
    expect(
      liveConversationsFromStored(
        {
          career: { ...copy, liveSide: "remote", liveThreadId: "thread-on-server" },
          ops: { ...copy, liveSide: "local", liveThreadId: "thread-on-mac" },
        },
        environmentOf,
      ),
    ).toEqual({
      career: { environmentId: "server", threadId: "thread-on-server" },
      ops: { environmentId: "mac", threadId: "thread-on-mac" },
    });
  });

  it("skips records it cannot read instead of guessing a side", () => {
    expect(
      liveConversationsFromStored(
        {
          broken: { ...copy, liveSide: "elsewhere", liveThreadId: "x" } as never,
          empty: { ...copy, liveSide: "remote", liveThreadId: "" },
        },
        environmentOf,
      ),
    ).toEqual({});
  });
});

describe("findConversationCopy", () => {
  const environmentOf = (side: "local" | "remote") => (side === "local" ? "mac" : "server");
  const record: ConversationCopyState = {
    liveSide: "remote",
    liveThreadId: "agent:a",
    copiedCount: 4,
    copyThreadId: "transfer:copy",
    copyMessageCount: 4,
  };

  it("recognises the copy and points at the live thread", () => {
    expect(
      findConversationCopy({ a: record }, environmentOf, {
        environmentId: "mac",
        threadId: "transfer:copy",
      }),
    ).toEqual({ agentId: "a", live: { environmentId: "server", threadId: "agent:a" } });
  });

  it("does not call the live thread a copy", () => {
    expect(
      findConversationCopy({ a: record }, environmentOf, {
        environmentId: "server",
        threadId: "agent:a",
      }),
    ).toBeNull();
  });

  it("does not match the same thread id on the other environment", () => {
    expect(
      findConversationCopy({ a: record }, environmentOf, {
        environmentId: "server",
        threadId: "transfer:copy",
      }),
    ).toBeNull();
  });

  it("follows the live side when it is local", () => {
    expect(
      findConversationCopy(
        { a: { ...record, liveSide: "local", liveThreadId: "thread-on-mac" } },
        environmentOf,
        { environmentId: "server", threadId: "transfer:copy" },
      ),
    ).toEqual({ agentId: "a", live: { environmentId: "mac", threadId: "thread-on-mac" } });
  });

  it("ignores records it cannot read", () => {
    expect(
      findConversationCopy(
        {
          a: { ...record, liveSide: "elsewhere" } as never,
          b: { ...record, liveThreadId: "" },
          c: { ...record, liveThreadId: "transfer:copy" },
        },
        environmentOf,
        { environmentId: "mac", threadId: "transfer:copy" },
      ),
    ).toBeNull();
  });
});

describe("decideCopySend", () => {
  it("asks once a copy is about to be typed into while the live side is reachable", () => {
    expect(decideCopySend({ isCopy: true, liveReachable: true, confirmed: false })).toBe("confirm");
  });

  it("sends once the user said to send here", () => {
    expect(decideCopySend({ isCopy: true, liveReachable: true, confirmed: true })).toBe("send");
  });

  it("sends from a copy when the live side is offline", () => {
    expect(decideCopySend({ isCopy: true, liveReachable: false, confirmed: false })).toBe("send");
  });

  it("never asks in a conversation that is not a copy", () => {
    expect(decideCopySend({ isCopy: false, liveReachable: true, confirmed: false })).toBe("send");
  });
});

describe("selectOldTransferCopies", () => {
  const pair = { liveThreadId: "agent:a", copyThreadId: "transfer:current" };

  it("selects transfer copies that are neither the agent's thread nor the live and copy pair", () => {
    expect(
      selectOldTransferCopies({
        threadIds: ["agent:a", "transfer:old-1", "transfer:current", "transfer:old-2"],
        primaryThreadId: "transfer:current",
        pair,
      }),
    ).toEqual(["transfer:old-1", "transfer:old-2"]);
  });

  it("keeps the primary thread even when the pairing is unknown", () => {
    expect(
      selectOldTransferCopies({
        threadIds: ["transfer:primary", "transfer:old"],
        primaryThreadId: "transfer:primary",
        pair: null,
      }),
    ).toEqual(["transfer:old"]);
  });

  it("keeps the live thread of the pair when it is a transfer copy itself", () => {
    expect(
      selectOldTransferCopies({
        threadIds: ["transfer:was-copy", "transfer:copy", "transfer:old"],
        primaryThreadId: "transfer:was-copy",
        pair: { liveThreadId: "transfer:was-copy", copyThreadId: "transfer:copy" },
      }),
    ).toEqual(["transfer:old"]);
  });

  it("never selects threads the user started or the agent's own conversations", () => {
    expect(
      selectOldTransferCopies({
        threadIds: ["agent:a", "9d1f-task-thread", "transfer:old"],
        primaryThreadId: "agent:a",
        pair,
      }),
    ).toEqual(["transfer:old"]);
  });

  it("lists a thread once and returns nothing when there is nothing to clean up", () => {
    expect(
      selectOldTransferCopies({
        threadIds: ["transfer:old", "transfer:old"],
        primaryThreadId: null,
        pair: null,
      }),
    ).toEqual(["transfer:old"]);
    expect(
      selectOldTransferCopies({ threadIds: ["agent:a"], primaryThreadId: "agent:a", pair }),
    ).toEqual([]);
  });
});
