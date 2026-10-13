import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  THREAD_TRANSFER_MAX_MESSAGES,
  type ThreadTransferExport,
  type ThreadTransferImportInput,
  type ThreadTransferMessage,
  type ThreadTransferWorkspace,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AgentMoveProject } from "./agentMove.ts";
import {
  buildTransferNote,
  describeTransferWorkspace,
  executeContinueOn,
  limitTransferMessages,
  pickTransferModel,
  planTransferProject,
  threadIsBusyForTransfer,
  type TransferTargetProvider,
} from "./threadTransfer.ts";

const mac = EnvironmentId.make("mac");
const server = EnvironmentId.make("server");

const identity = (rootPath: string, key = "github.com/acme/app") => ({
  canonicalKey: key,
  locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: `https://${key}.git` },
  rootPath,
});

const project = (
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  repo: ReturnType<typeof identity> | null,
): AgentMoveProject => ({
  environmentId,
  id: ProjectId.make(id),
  workspaceRoot,
  repositoryIdentity: repo,
});

describe("planTransferProject", () => {
  const sourceIdentity = identity("/Users/me/app");
  const source = project(mac, "p-mac", "/Users/me/app", sourceIdentity);

  it("preselects the only project for the repository", () => {
    const match = project(server, "p-srv", "/srv/app", identity("/srv/app"));
    const other = project(
      server,
      "p-other",
      "/srv/other",
      identity("/srv/other", "github.com/acme/other"),
    );
    const plan = planTransferProject({
      sourceProject: source,
      exportedIdentity: sourceIdentity,
      targetProjects: [other, match],
    });
    expect(plan.preselected).toBe(match);
    expect(plan.candidates).toEqual([match]);
    expect(plan.scratchAvailable).toBe(true);
  });

  it("offers nothing to preselect when no project is the same repository", () => {
    const other = project(
      server,
      "p-other",
      "/srv/other",
      identity("/srv/other", "github.com/acme/other"),
    );
    const bare = project(server, "p-bare", "/srv/bare", null);
    const plan = planTransferProject({
      sourceProject: source,
      exportedIdentity: sourceIdentity,
      targetProjects: [other, bare],
    });
    expect(plan.candidates).toEqual([]);
    expect(plan.preselected).toBeNull();
    expect(plan.scratchAvailable).toBe(true);
  });

  it("makes the user choose between several projects of the repository", () => {
    const a = project(server, "p-a", "/srv/app/apps/a", identity("/srv/app"));
    const b = project(server, "p-b", "/srv/app/apps/b", identity("/srv/app"));
    const plan = planTransferProject({
      sourceProject: source,
      exportedIdentity: sourceIdentity,
      targetProjects: [a, b],
    });
    expect(plan.candidates).toEqual([a, b]);
    expect(plan.preselected).toBeNull();
  });

  it("prefers the project at the same folder inside the repository", () => {
    const a = project(server, "p-a", "/srv/app/apps/a", identity("/srv/app"));
    const b = project(server, "p-b", "/srv/app/apps/b", identity("/srv/app"));
    const sourceInFolder = project(mac, "p-mac-a", "/Users/me/app/apps/a", sourceIdentity);
    const plan = planTransferProject({
      sourceProject: sourceInFolder,
      exportedIdentity: sourceIdentity,
      targetProjects: [b, a],
    });
    expect(plan.preselected).toBe(a);
    expect(plan.candidates).toHaveLength(2);
  });

  it("uses the identity the source server exported over the client's copy", () => {
    const match = project(server, "p-srv", "/srv/app", identity("/srv/app"));
    const unidentified = project(mac, "p-mac", "/Users/me/app", null);
    const plan = planTransferProject({
      sourceProject: unidentified,
      exportedIdentity: identity("/Users/me/app"),
      targetProjects: [match],
    });
    expect(plan.preselected).toBe(match);
    expect(
      planTransferProject({
        sourceProject: unidentified,
        exportedIdentity: null,
        targetProjects: [match],
      }).preselected,
    ).toBeNull();
  });
});

describe("pickTransferModel", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const provider = (
    instanceId: ProviderInstanceId,
    overrides: Partial<TransferTargetProvider> = {},
  ): TransferTargetProvider => ({
    instanceId,
    enabled: true,
    models: [
      { slug: `${instanceId}-small`, isCustom: false },
      { slug: `${instanceId}-main`, isCustom: false, isDefault: true },
    ],
    ...overrides,
  });
  const source = { instanceId: codex, model: "gpt-5.4" };

  it("keeps the source selection when its instance offers that model on the target", () => {
    const listed = { instanceId: codex, model: `${codex}-small` };
    expect(
      pickTransferModel({
        source: listed,
        targetProviders: [provider(claude), provider(codex)],
        targetProjectDefault: null,
      }),
    ).toEqual({ selection: listed, origin: "same_instance" });
  });

  it("uses a target default when the same instance does not offer the model there", () => {
    expect(
      pickTransferModel({
        source,
        targetProviders: [provider(codex)],
        targetProjectDefault: null,
      }),
    ).toEqual({
      selection: { instanceId: codex, model: `${codex}-main` },
      origin: "target_default",
    });
  });

  it("falls back to the target project's default when the source instance is missing there", () => {
    const projectDefault = { instanceId: claude, model: "claude-project-pick" };
    expect(
      pickTransferModel({
        source,
        targetProviders: [provider(claude)],
        targetProjectDefault: projectDefault,
      }),
    ).toEqual({ selection: projectDefault, origin: "target_default" });
  });

  it("falls back to the first usable provider's default model", () => {
    expect(
      pickTransferModel({
        source,
        targetProviders: [
          provider(codex, { enabled: false }),
          provider(ProviderInstanceId.make("gone"), { availability: "unavailable" }),
          provider(claude),
        ],
        targetProjectDefault: { instanceId: codex, model: "ignored-because-disabled" },
      }),
    ).toEqual({
      selection: { instanceId: claude, model: "claudeAgent-main" },
      origin: "target_default",
    });
  });

  it("reports when the target has nothing to run the thread on", () => {
    expect(
      pickTransferModel({
        source,
        targetProviders: [
          provider(claude, { enabled: false }),
          provider(codex, { enabled: false }),
        ],
        targetProjectDefault: null,
      }),
    ).toEqual({ selection: null, origin: "none" });
  });
});

const workspace = (overrides: Partial<ThreadTransferWorkspace> = {}): ThreadTransferWorkspace => ({
  cwd: "/Users/me/app",
  isRepo: true,
  branch: "feature/x",
  isDefaultBranch: false,
  headSha: "abc123def456",
  hasWorkingTreeChanges: false,
  changedFiles: [],
  hasUpstream: true,
  aheadCount: 0,
  ...overrides,
});

describe("describeTransferWorkspace", () => {
  it("is clean only when pushed and committed", () => {
    expect(describeTransferWorkspace(workspace())).toMatchObject({
      kind: "clean",
      needsAcknowledgement: false,
    });
  });

  it("flags unpushed commits, a branch never pushed, and a detached head", () => {
    expect(describeTransferWorkspace(workspace({ aheadCount: 2 }))).toMatchObject({
      kind: "unpushed",
      canPush: true,
      needsAcknowledgement: true,
    });
    expect(describeTransferWorkspace(workspace({ hasUpstream: false }))).toMatchObject({
      kind: "unpushed",
    });
    expect(describeTransferWorkspace(workspace({ branch: null }))).toMatchObject({
      kind: "unpushed",
      canPush: false,
    });
    // The default branch is never pushed from the dialog; that goes through the Git menu's prompt.
    expect(
      describeTransferWorkspace(
        workspace({ branch: "main", isDefaultBranch: true, aheadCount: 1 }),
      ),
    ).toMatchObject({ kind: "unpushed", canPush: false });
  });

  it("puts uncommitted files ahead of unpushed commits and keeps both flags", () => {
    expect(
      describeTransferWorkspace(
        workspace({ hasWorkingTreeChanges: true, changedFiles: ["a.ts"], aheadCount: 1 }),
      ),
    ).toMatchObject({ kind: "uncommitted", hasUncommitted: true, hasUnpushed: true });
  });

  it("asks for nothing when the folder is not a repository", () => {
    expect(describeTransferWorkspace(workspace({ isRepo: false }))).toMatchObject({
      kind: "not_a_repository",
      needsAcknowledgement: false,
    });
  });
});

describe("buildTransferNote", () => {
  it("names the environment, the branch and commit, and what did not travel", () => {
    const note = buildTransferNote({
      sourceEnvironmentLabel: "Ryan's Mac",
      workspace: workspace(),
      omittedCount: 0,
    });
    expect(note).toContain("Ryan's Mac");
    expect(note).toContain("branch feature/x at commit abc123def456");
    expect(note).toContain("file paths mentioned earlier refer to that machine");
    expect(note).toContain("Tool calls, command output and attachments were not carried over");
    expect(note).not.toContain("uncommitted");
    expect(note).not.toContain("left out");
  });

  it("lists uncommitted files, at most twenty, and says how many more", () => {
    const files = Array.from({ length: 23 }, (_, index) => `src/file-${index}.ts`);
    const note = buildTransferNote({
      sourceEnvironmentLabel: "Mac",
      workspace: workspace({ hasWorkingTreeChanges: true, changedFiles: files }),
      omittedCount: 0,
    });
    expect(note).toContain("Uncommitted changes (23 files) stayed on the other machine");
    expect(note).toContain("- src/file-19.ts");
    expect(note).not.toContain("src/file-20.ts");
    expect(note).toContain("- and 3 more");
  });

  it("says unpushed commits are not available, and how many messages were omitted", () => {
    const note = buildTransferNote({
      sourceEnvironmentLabel: "Mac",
      workspace: workspace({ aheadCount: 1 }),
      omittedCount: 2,
    });
    expect(note).toContain("1 commit on that branch had not been pushed, so it is not available");
    expect(note).toContain("2 earlier messages were left out");
    expect(
      buildTransferNote({
        sourceEnvironmentLabel: "Mac",
        workspace: workspace({ hasUpstream: false }),
        omittedCount: 0,
      }),
    ).toContain("never pushed");
  });

  it("has no code to fetch outside a repository", () => {
    const note = buildTransferNote({
      sourceEnvironmentLabel: "Mac",
      workspace: workspace({ isRepo: false, branch: null, headSha: null }),
      omittedCount: 0,
    });
    expect(note).toContain("not a git repository");
    expect(note).not.toContain("branch");
  });
});

const message = (index: number): ThreadTransferMessage => ({
  role: index % 2 === 0 ? "user" : "assistant",
  text: `message ${index}`,
  createdAt: "2026-03-01T00:00:00.000Z",
});

describe("limitTransferMessages", () => {
  it("keeps the newest messages past the count limit and reports the rest", () => {
    const messages = Array.from({ length: THREAD_TRANSFER_MAX_MESSAGES + 2 }, (_, index) =>
      message(index),
    );
    const limited = limitTransferMessages(messages);
    expect(limited.omittedCount).toBe(2);
    expect(limited.messages).toHaveLength(THREAD_TRANSFER_MAX_MESSAGES);
    expect(limited.messages[0]!.text).toBe("message 2");
    expect(limitTransferMessages([message(0)])).toEqual({
      messages: [message(0)],
      omittedCount: 0,
    });
  });
});

describe("executeContinueOn", () => {
  const exported: ThreadTransferExport = {
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("p-mac"),
    title: "Fix the thing",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    repositoryIdentity: null,
    messages: [message(0), message(1)],
    workspace: workspace({ aheadCount: 1 }),
  };
  const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-x" };

  const makePorts = (overrides: { readonly settle?: () => Promise<void> } = {}) => {
    const calls: Array<string> = [];
    let imported: ThreadTransferImportInput | null = null;
    return {
      calls,
      imported: () => imported,
      ports: {
        ensureScratch: async () => {
          calls.push("ensureScratch");
          return ProjectId.make("p-scratch");
        },
        importThread: async (input: ThreadTransferImportInput) => {
          calls.push("import");
          imported = input;
          return {
            threadId: ThreadId.make(`transfer:${input.transferId}`),
            alreadyImported: false,
            importedMessageCount: input.messages.length,
            omittedMessageCount: 0,
          };
        },
        settleSource: async () => {
          calls.push("settle");
          await overrides.settle?.();
        },
      },
    };
  };

  it("imports into the chosen project with the target's model, then settles the source", async () => {
    const { ports, calls, imported } = makePorts();
    const result = await executeContinueOn({
      ports,
      transferId: "t-1",
      exported,
      target: { kind: "project", projectId: ProjectId.make("p-srv") },
      modelSelection,
      sourceEnvironmentLabel: "Mac",
    });
    expect(calls).toEqual(["import", "settle"]);
    expect(result.targetThreadId).toBe("transfer:t-1");
    expect(result.settleError).toBeNull();
    expect(imported()).toMatchObject({
      transferId: "t-1",
      projectId: "p-srv",
      title: "Fix the thing",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
    });
    expect(imported()!.messages).toEqual(exported.messages);
    expect(imported()!.note).toContain("branch feature/x");
  });

  it("uses the target's personal workspace when asked", async () => {
    const { ports, calls, imported } = makePorts();
    await executeContinueOn({
      ports,
      transferId: "t-2",
      exported,
      target: { kind: "scratch" },
      modelSelection,
      sourceEnvironmentLabel: "Mac",
    });
    expect(calls).toEqual(["ensureScratch", "import", "settle"]);
    expect(imported()!.projectId).toBe("p-scratch");
  });

  it("still returns the new thread when settling the source fails", async () => {
    const failure = new Error("settle refused");
    const { ports } = makePorts({
      settle: async () => {
        throw failure;
      },
    });
    const result = await executeContinueOn({
      ports,
      transferId: "t-3",
      exported,
      target: { kind: "project", projectId: ProjectId.make("p-srv") },
      modelSelection,
      sourceEnvironmentLabel: "Mac",
    });
    expect(result.targetThreadId).toBe("transfer:t-3");
    expect(result.settleError).toBe(failure);
  });

  it("leaves the source alone when the import fails", async () => {
    const { ports, calls } = makePorts();
    await expect(
      executeContinueOn({
        ports: {
          ...ports,
          importThread: async () => {
            calls.push("import");
            throw new Error("target unreachable");
          },
        },
        transferId: "t-4",
        exported,
        target: { kind: "project", projectId: ProjectId.make("p-srv") },
        modelSelection,
        sourceEnvironmentLabel: "Mac",
      }),
    ).rejects.toThrow("target unreachable");
    expect(calls).toEqual(["import"]);
  });
});

describe("threadIsBusyForTransfer", () => {
  it("matches the runs the server refuses to export", () => {
    for (const status of ["preparing", "queued", "starting", "running"] as const) {
      expect(threadIsBusyForTransfer({ status })).toBe(true);
    }
    for (const status of ["idle", "waiting", "completed", "failed", "interrupted"] as const) {
      expect(threadIsBusyForTransfer({ status })).toBe(false);
    }
    expect(threadIsBusyForTransfer(null)).toBe(false);
  });
});
