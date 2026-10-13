import { EnvironmentId, ProjectId, type WorkspaceAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_MOVE_MESSAGES,
  describeAgentMoveFailure,
  planAgentMove,
  planAgentMoves,
  type AgentMoveProject,
} from "./agentMove.ts";

const mac = EnvironmentId.make("mac");
const server = EnvironmentId.make("server");

const identity = (key: string, rootPath: string) => ({
  canonicalKey: key,
  locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: `https://${key}.git` },
  rootPath,
});

function project(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  repo: ReturnType<typeof identity> | null,
): AgentMoveProject {
  return { environmentId, id: ProjectId.make(id), workspaceRoot, repositoryIdentity: repo };
}

const key = (p: AgentMoveProject) => JSON.stringify([p.environmentId, p.id]);

function agent(
  id: string,
  overrides: {
    projectKey?: string;
    modelSelection?: WorkspaceAgent["profile"]["modelSelection"];
  } & Partial<Omit<WorkspaceAgent, "profile">> = {},
): WorkspaceAgent {
  const { projectKey, modelSelection, ...rest } = overrides;
  return {
    profile: {
      id,
      name: `Agent ${id}`,
      description: "does things",
      instructions: "be useful",
      color: "#22c55e",
      pinned: true,
      projectKey: projectKey ?? "",
      runtimeMode: "inherit",
      modelSelection: modelSelection ?? null,
    },
    revision: 4,
    archive: null,
    recovery: {
      disposition: "ready",
      summary: "ok",
      blockers: [],
      verifiedAt: null,
      evidence: [],
    },
    memories: [{ id: "m1", text: "likes tabs", origin: "user", sources: [] }],
    primaryThreadId: "agent:source-thread",
    threadIds: ["agent:source-thread", "t2"],
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...rest,
  };
}

const model = (instanceId: string) =>
  ({ instanceId, model: "m" }) as NonNullable<WorkspaceAgent["profile"]["modelSelection"]>;

const macRepo = project(
  mac,
  "p-mac",
  "/Users/r/code/site",
  identity("github.com/a/site", "/Users/r/code/site"),
);
const serverRepo = project(
  server,
  "p-srv",
  "/srv/site",
  identity("github.com/a/site", "/srv/site"),
);
const base = {
  targetAgents: [] as WorkspaceAgent[],
  sourceProjects: [macRepo],
  targetProjects: [serverRepo],
  targetProviders: [{ instanceId: "codex", enabled: true }],
};

describe("planAgentMove", () => {
  it("creates a new record without conversation links and remaps the project", () => {
    const plan = planAgentMove({
      ...base,
      source: agent("a", { projectKey: key(macRepo), modelSelection: model("codex") }),
    });
    expect(plan.verdict).toMatchObject({ mode: "create", notes: [], blocked: false });
    expect(plan.verdict.messages).toEqual([AGENT_MOVE_MESSAGES.willMove]);
    expect(plan.expectedRevision).toBe(0);
    expect(plan.record).toMatchObject({
      revision: 0,
      primaryThreadId: null,
      threadIds: [],
      archivedAt: null,
      memories: [{ id: "m1" }],
    });
    expect(plan.record?.profile.projectKey).toBe(key(serverRepo));
    expect(plan.record?.profile.modelSelection).toEqual(model("codex"));
  });

  it("falls back to the personal workspace when no target project is the same repository", () => {
    const plan = planAgentMove({
      ...base,
      targetProjects: [
        project(server, "other", "/srv/other", identity("github.com/a/other", "/srv/other")),
      ],
      source: agent("a", { projectKey: key(macRepo) }),
    });
    expect(plan.verdict.notes).toEqual(["project_missing"]);
    expect(plan.verdict.messages).toEqual([AGENT_MOVE_MESSAGES.project_missing]);
    expect(plan.record?.profile.projectKey).toBe("");
    expect(plan.verdict.stayByDefault).toBe(false);
  });

  it("treats a project without repository identity, or one unknown to the source, as missing", () => {
    const bare = project(mac, "bare", "/Users/r/bare", null);
    expect(
      planAgentMove({
        ...base,
        sourceProjects: [bare],
        source: agent("a", { projectKey: key(bare) }),
      }).verdict.notes,
    ).toEqual(["project_missing"]);
    expect(
      planAgentMove({ ...base, source: agent("a", { projectKey: "not json" }) }).verdict.notes,
    ).toEqual(["project_missing"]);
  });

  it("keeps the personal workspace as is", () => {
    const plan = planAgentMove({ ...base, source: agent("a") });
    expect(plan.verdict.notes).toEqual([]);
    expect(plan.record?.profile.projectKey).toBe("");
  });

  it("prefers the same folder inside a repository and refuses an ambiguous match", () => {
    const sub = project(
      mac,
      "sub",
      "/Users/r/code/mono/web",
      identity("github.com/a/mono", "/Users/r/code/mono"),
    );
    const tRoot = project(
      server,
      "t-root",
      "/srv/mono",
      identity("github.com/a/mono", "/srv/mono"),
    );
    const tWeb = project(
      server,
      "t-web",
      "/srv/mono/web",
      identity("github.com/a/mono", "/srv/mono"),
    );
    const source = agent("a", { projectKey: key(sub) });
    expect(
      planAgentMove({ ...base, sourceProjects: [sub], targetProjects: [tRoot, tWeb], source })
        .record?.profile.projectKey,
    ).toBe(key(tWeb));
    const tDocs = project(
      server,
      "t-docs",
      "/srv/mono/docs",
      identity("github.com/a/mono", "/srv/mono"),
    );
    expect(
      planAgentMove({ ...base, sourceProjects: [sub], targetProjects: [tRoot, tDocs], source })
        .verdict.notes,
    ).toEqual(["project_missing"]);
  });

  it("drops a model whose instance is disabled on the target", () => {
    const plan = planAgentMove({
      ...base,
      targetProviders: [{ instanceId: "codex", enabled: false }],
      source: agent("a", { modelSelection: model("codex") }),
    });
    expect(plan.verdict.notes).toEqual(["model_unavailable"]);
    expect(plan.verdict.stayByDefault).toBe(false);
    expect(plan.record?.profile.modelSelection).toBeNull();
  });

  it("flags a model that only exists on this machine to stay by default", () => {
    const plan = planAgentMove({
      ...base,
      source: agent("a", { modelSelection: model("claudeAgent_mac_account") }),
    });
    expect(plan.verdict.notes).toEqual(["machine_only_model"]);
    expect(plan.verdict.stayByDefault).toBe(true);
    expect(plan.verdict.messages).toEqual([AGENT_MOVE_MESSAGES.machine_only_model]);
    expect(plan.record?.profile.modelSelection).toBeNull();
  });

  it("reports project and model notes together", () => {
    const plan = planAgentMove({
      ...base,
      sourceProjects: [],
      source: agent("a", { projectKey: key(macRepo), modelSelection: model("gone") }),
    });
    expect(plan.verdict.notes).toEqual(["project_missing", "machine_only_model"]);
  });

  it("merges into an existing id: source profile, memories and recovery win, target links and revision stay", () => {
    const stored = agent("a", {
      revision: 9,
      primaryThreadId: "agent:target-thread",
      threadIds: ["agent:target-thread"],
      archivedAt: "2026-09-30T00:00:00.000Z",
      memories: [],
      recovery: {
        disposition: "blocked",
        summary: "old",
        blockers: ["x"],
        verifiedAt: null,
        evidence: [],
      },
      routineOwnershipVerified: true,
    });
    const existing: WorkspaceAgent = {
      ...stored,
      profile: { ...stored.profile, name: "Old Name" },
    };
    const source = agent("a", { projectKey: key(macRepo), modelSelection: model("codex") });
    const plan = planAgentMove({ ...base, targetAgents: [existing], source });
    expect(plan.verdict.mode).toBe("merge");
    expect(plan.expectedRevision).toBe(9);
    expect(plan.record).toMatchObject({
      revision: 9,
      primaryThreadId: "agent:target-thread",
      threadIds: ["agent:target-thread"],
      routineOwnershipVerified: true,
      archivedAt: null,
      memories: source.memories,
      recovery: source.recovery,
    });
    expect(plan.record?.profile.name).toBe(source.profile.name);
    expect(plan.record?.profile.projectKey).toBe(key(serverRepo));
  });

  it("blocks a merge whose imported history differs, because the server will not change it", () => {
    const archive = (messages: number) => ({
      id: "a",
      sourceId: "s",
      name: "A",
      importedAt: "x",
      exportedAt: "y",
      sourceSettings: {},
      messages: Array.from({ length: messages }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "hi",
        timestampMs: null,
      })),
    });
    const blocked = planAgentMove({
      ...base,
      targetAgents: [agent("a", { archive: archive(1) })],
      source: agent("a", { archive: archive(2) }),
    });
    expect(blocked.verdict).toMatchObject({ blocked: true, notes: ["archive_differs"] });
    expect(blocked.record).toBeNull();
    const same = planAgentMove({
      ...base,
      targetAgents: [agent("a", { archive: archive(2) })],
      source: agent("a", { archive: archive(2) }),
    });
    expect(same.verdict.blocked).toBe(false);
  });
});

describe("planAgentMoves", () => {
  it("skips archived source agents", () => {
    const plans = planAgentMoves({
      ...base,
      sourceAgents: [agent("a"), agent("b", { archivedAt: "2026-10-01T00:00:00.000Z" })],
    });
    expect(plans.map((p) => p.verdict.agentId)).toEqual(["a"]);
  });
});

describe("describeAgentMoveFailure", () => {
  it("maps workspace error reasons to sentences", () => {
    const sentences = new Set(
      ["conflict", "invalid_import", "storage", "recovery_required", "not_found"].map((reason) =>
        describeAgentMoveFailure({ _tag: "AgentWorkspaceError", reason }),
      ),
    );
    expect(sentences.size).toBe(5);
    expect(describeAgentMoveFailure(new Error("boom"))).toBe(
      "The target could not save this agent.",
    );
  });
});
