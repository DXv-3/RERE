import { ProviderInstanceId, type WorkspaceAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planAgentSync,
  type AgentSyncBase,
  type AgentSyncSide,
  type AgentSyncStep,
} from "./agentSync.ts";

function agent(id: string, overrides: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    profile: {
      id,
      name: `Agent ${id}`,
      description: "does things",
      instructions: "be useful",
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
    primaryThreadId: null,
    threadIds: [],
    archivedAt: null,
    updatedAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

const edit = (
  source: WorkspaceAgent,
  profile: Partial<WorkspaceAgent["profile"]>,
  updatedAt: string,
): WorkspaceAgent => ({ ...source, profile: { ...source.profile, ...profile }, updatedAt });

const memory = (id: string, text: string) => ({
  id,
  text,
  origin: "user" as const,
  sources: [],
});

const side = (agents: ReadonlyArray<WorkspaceAgent>): AgentSyncSide => ({
  agents,
  projects: [],
  providers: [],
});

/** Two servers and the client's remembered bases, applying saves the way the server does. */
function world(localAgents: WorkspaceAgent[], remoteAgents: WorkspaceAgent[]) {
  const state = { local: localAgents, remote: remoteAgents };
  let bases: Record<string, AgentSyncBase> = {};
  let clock = 0;
  const sync = (): ReadonlyArray<AgentSyncStep> => {
    const steps = planAgentSync({ local: side(state.local), remote: side(state.remote), bases });
    for (const step of steps) {
      for (const save of step.saves) {
        const stored = {
          ...save.record,
          revision: save.expectedRevision + 1,
          updatedAt: `2026-10-04T12:00:${String((clock += 1)).padStart(2, "0")}.000Z`,
        };
        state[save.side] = [
          ...state[save.side].filter((a) => a.profile.id !== stored.profile.id),
          stored,
        ];
      }
      bases = { ...bases, [step.agentId]: step.nextBase };
    }
    return steps;
  };
  const get = (which: "local" | "remote", id: string) =>
    state[which].find((a) => a.profile.id === id)!;
  const set = (which: "local" | "remote", next: WorkspaceAgent) => {
    state[which] = state[which].map((a) => (a.profile.id === next.profile.id ? next : a));
  };
  const saveCount = (steps: ReadonlyArray<AgentSyncStep>) =>
    steps.reduce((total, step) => total + step.saves.length, 0);
  return { sync, get, set, saveCount };
}

describe("planAgentSync", () => {
  it("settles after one pass even though each save restamps the record", () => {
    const w = world([agent("a")], [agent("a")]);
    w.sync();
    w.set("local", edit(w.get("local", "a"), { name: "Renamed" }, "2026-10-04T11:00:00.000Z"));

    expect(w.saveCount(w.sync())).toBe(1);
    expect(w.get("remote", "a").profile.name).toBe("Renamed");
    expect(w.saveCount(w.sync())).toBe(0);
  });

  it("merges edits to different fields and lets the newer side win the same field", () => {
    const w = world([agent("a")], [agent("a")]);
    w.sync();
    w.set(
      "local",
      edit(
        w.get("local", "a"),
        { name: "Mac name", instructions: "mac rules" },
        "2026-10-04T11:00:00.000Z",
      ),
    );
    w.set(
      "remote",
      edit(
        w.get("remote", "a"),
        { name: "Server name", color: "#000000" },
        "2026-10-04T11:30:00.000Z",
      ),
    );
    w.sync();

    for (const which of ["local", "remote"] as const) {
      expect(w.get(which, "a").profile).toMatchObject({
        name: "Server name",
        instructions: "mac rules",
        color: "#000000",
      });
    }
  });

  it("does not re-block an agent that was resumed on the other side", () => {
    const blocked = {
      disposition: "blocked" as const,
      summary: "Imported.",
      blockers: ["Verify first."],
      verifiedAt: null,
      evidence: [],
    };
    const w = world([agent("a", { recovery: blocked })], [agent("a", { recovery: blocked })]);
    w.sync();
    const resumed = {
      disposition: "ready" as const,
      summary: "Checked.",
      blockers: [],
      verifiedAt: "2026-10-04T11:00:00.000Z",
      evidence: ["looked"],
    };
    w.set("remote", { ...w.get("remote", "a"), recovery: resumed });
    // The Mac copy is edited later, which must not carry its stale blocked state across.
    w.set("local", edit(w.get("local", "a"), { name: "Later" }, "2026-10-04T11:45:00.000Z"));
    w.sync();

    expect(w.get("local", "a").recovery).toEqual(resumed);
    expect(w.get("remote", "a").recovery).toEqual(resumed);
    expect(w.get("remote", "a").profile.name).toBe("Later");
  });

  it("leaves a field alone when the copies differ and have never been in sync", () => {
    const w = world(
      [agent("a", { memories: [memory("m1", "mac")] })],
      [
        edit(
          agent("a", { memories: [memory("m2", "server")] }),
          { instructions: "server rules" },
          "2026-10-04T11:00:00.000Z",
        ),
      ],
    );
    const [step] = w.sync();

    expect(step!.unresolved).toEqual(["instructions"]);
    expect(w.get("local", "a").profile.instructions).toBe("be useful");
    expect(w.get("remote", "a").profile.instructions).toBe("server rules");
    // Memories only one side had are additions, not conflicts.
    expect(w.get("local", "a").memories.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(w.get("remote", "a").memories.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("carries an owner's tool switches across, including switching them back on", () => {
    const w = world([agent("a")], [agent("a")]);
    w.sync();
    w.set(
      "local",
      edit(
        w.get("local", "a"),
        { blockedToolGroups: ["preview", "worktree"] },
        "2026-10-05T10:00:00.000Z",
      ),
    );
    w.sync();
    expect(w.get("remote", "a").profile.blockedToolGroups).toEqual(["preview", "worktree"]);

    // Switching everything back on on the other side is an explicit empty list, not a missing field.
    w.set(
      "remote",
      edit(w.get("remote", "a"), { blockedToolGroups: [] }, "2026-10-05T11:00:00.000Z"),
    );
    w.sync();
    expect(w.get("local", "a").profile.blockedToolGroups).toEqual([]);
    expect(w.saveCount(w.sync())).toBe(0);
  });

  it("does not treat a missing list and an empty list as different", () => {
    const w = world(
      [agent("a")],
      [edit(agent("a"), { blockedToolGroups: [] }, "2026-10-04T10:00:00.000Z")],
    );
    expect(w.saveCount(w.sync())).toBe(0);
  });

  it("copies a restriction to a copy that never had one on the first meeting", () => {
    const restricted = edit(
      agent("a"),
      { blockedToolGroups: ["device"] },
      "2026-10-04T09:00:00.000Z",
    );
    const w = world([agent("a")], [restricted]);
    const steps = w.sync();
    expect(steps.every((step) => step.unresolved.length === 0)).toBe(true);
    expect(w.get("local", "a").profile.blockedToolGroups).toEqual(["device"]);
  });

  it("carries a memory removal across unless the other side edited it", () => {
    const start = [memory("keep", "one"), memory("drop", "two"), memory("edited", "three")];
    const w = world([agent("a", { memories: start })], [agent("a", { memories: start })]);
    w.sync();
    w.set("local", { ...w.get("local", "a"), memories: [memory("keep", "one")] });
    w.set("remote", {
      ...w.get("remote", "a"),
      memories: [memory("keep", "one"), memory("drop", "two"), memory("edited", "changed")],
    });
    w.sync();

    for (const which of ["local", "remote"] as const) {
      expect(w.get(which, "a").memories).toEqual([
        memory("keep", "one"),
        memory("edited", "changed"),
      ]);
    }
  });

  it("hides and shows an agent on both sides", () => {
    const w = world([agent("a")], [agent("a")]);
    w.sync();
    w.set("remote", { ...w.get("remote", "a"), archivedAt: "2026-10-04T11:00:00.000Z" });
    w.sync();
    expect(w.get("local", "a").archivedAt).toBe("2026-10-04T11:00:00.000Z");

    w.set("local", { ...w.get("local", "a"), archivedAt: null });
    w.sync();
    expect(w.get("remote", "a").archivedAt).toBeNull();
  });

  it("creates a missing agent without links and drops a model the other side lacks", () => {
    const source = agent("a", {
      primaryThreadId: "thread-1",
      threadIds: ["thread-1"],
      profile: {
        ...agent("a").profile,
        modelSelection: { instanceId: ProviderInstanceId.make("local"), model: "qwen38" },
      },
    });
    const steps = planAgentSync({
      local: side([source, agent("hidden", { archivedAt: "2026-10-01T00:00:00.000Z" })]),
      remote: {
        agents: [],
        projects: [],
        providers: [{ instanceId: "local", enabled: true, models: [{ slug: "claude-opus-5-5" }] }],
      },
      bases: {},
    });

    expect(steps.map((step) => step.agentId)).toEqual(["a"]);
    expect(steps[0]!.saves).toMatchObject([
      {
        side: "remote",
        expectedRevision: 0,
        record: { primaryThreadId: null, threadIds: [], profile: { modelSelection: null } },
      },
    ]);
  });
});
