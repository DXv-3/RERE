import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type WorkspaceAgent } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  agentOwnedThreadIds,
  createAgentOwnedThreadsAtom,
  mostRecentOrdinaryThread,
  withoutAgentOwnedThreads,
} from "./agentOwnedThreads.ts";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function agent(
  primaryThreadId: string | null,
  threadIds?: string[],
  archivedAt?: string,
): WorkspaceAgent {
  return {
    primaryThreadId,
    ...(threadIds ? { threadIds } : {}),
    ...(archivedAt ? { archivedAt } : {}),
  } as unknown as WorkspaceAgent;
}

describe("agentOwnedThreadIds", () => {
  it("unions primary and recorded threads across agents, archived included", () => {
    const ids = agentOwnedThreadIds([
      agent("a-main", ["a-main", "a-2"]),
      agent(null, ["b-1"]),
      agent("c-main", undefined, "2026-01-01T00:00:00Z"),
    ]);
    expect([...ids].toSorted()).toEqual(["a-2", "a-main", "b-1", "c-main"]);
  });
});

describe("withoutAgentOwnedThreads", () => {
  const threads = [
    { environmentId: LOCAL, id: "t1" },
    { environmentId: LOCAL, id: "t2" },
    { environmentId: REMOTE, id: "t1" },
  ];

  it("matches ids per environment", () => {
    const owned = new Map([[LOCAL, new Set(["t1"])]]);
    expect(withoutAgentOwnedThreads(threads, owned)).toEqual([threads[1], threads[2]]);
  });

  it("returns the same array when nothing is owned or matches", () => {
    expect(withoutAgentOwnedThreads(threads, new Map())).toBe(threads);
    expect(withoutAgentOwnedThreads(threads, new Map([[LOCAL, new Set(["zzz"])]]))).toBe(threads);
  });
});

describe("createAgentOwnedThreadsAtom", () => {
  function setup() {
    const list = () =>
      Atom.make<AsyncResult.AsyncResult<ReadonlyArray<WorkspaceAgent>, unknown>>(
        AsyncResult.initial(true),
      );
    const lists = new Map([
      [LOCAL, list()],
      [REMOTE, list()],
    ]);
    const environmentIdsAtom = Atom.make<ReadonlyArray<EnvironmentId>>([LOCAL, REMOTE]);
    const owned = createAgentOwnedThreadsAtom({
      agentList: ({ environmentId }) => lists.get(environmentId)!,
      environmentIdsAtom,
    });
    return { lists, owned, registry: AtomRegistry.make() };
  }

  it("omits environments whose list has not loaded or failed so their threads stay visible", () => {
    const h = setup();
    expect(h.registry.get(h.owned).size).toBe(0);
    h.registry.set(h.lists.get(REMOTE)!, AsyncResult.fail(new Error("offline")));
    expect(h.registry.get(h.owned).size).toBe(0);
  });

  it("keeps each environment's agents separate", () => {
    const h = setup();
    h.registry.set(h.lists.get(LOCAL)!, AsyncResult.success([agent("a", ["a", "b"])]));
    const owned = h.registry.get(h.owned);
    expect(owned.get(LOCAL)?.has("b")).toBe(true);
    expect(owned.has(REMOTE)).toBe(false);
  });

  it("keeps identity across a refresh that returns the same threads", () => {
    const h = setup();
    h.registry.set(h.lists.get(LOCAL)!, AsyncResult.success([agent("a", ["b"])]));
    const first = h.registry.get(h.owned);
    h.registry.set(h.lists.get(LOCAL)!, AsyncResult.success([agent("a", ["b"])]));
    expect(h.registry.get(h.owned)).toBe(first);
    h.registry.set(h.lists.get(LOCAL)!, AsyncResult.success([agent("a", ["b", "c"])]));
    expect(h.registry.get(h.owned)).not.toBe(first);
  });
});

describe("mostRecentOrdinaryThread", () => {
  const thread = (
    id: string,
    updatedAt: string,
    extra: { archivedAt?: string | null; relationshipToParent?: string } = {},
  ) => ({
    environmentId: LOCAL,
    id,
    updatedAt,
    archivedAt: extra.archivedAt ?? null,
    lineage: { relationshipToParent: extra.relationshipToParent ?? "none" },
  });
  const owned = new Map([[LOCAL, new Set(["agent-chat"])]]);

  it("picks the latest thread that is not an agent's, archived, or a subagent", () => {
    const threads = [
      thread("older", "2026-10-01T10:00:00.000Z"),
      thread("newer", "2026-10-03T10:00:00.000Z"),
      thread("agent-chat", "2026-10-05T10:00:00.000Z"),
      thread("archived", "2026-10-04T10:00:00.000Z", { archivedAt: "2026-10-04T11:00:00.000Z" }),
      thread("child", "2026-10-04T12:00:00.000Z", { relationshipToParent: "subagent" }),
    ];
    expect(mostRecentOrdinaryThread(threads, owned)?.id).toBe("newer");
  });

  it("returns null when only agent conversations exist", () => {
    expect(
      mostRecentOrdinaryThread([thread("agent-chat", "2026-10-05T10:00:00.000Z")], owned),
    ).toBeNull();
  });
});
