// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  navigate: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  addShared: vi.fn(),
  setSticky: vi.fn(),
  cloud: false,
  signedIn: false,
  pendingShares: [] as Array<{ inviteId: string; label: string; models: string[] }>,
  refreshShares: vi.fn(),
  collectShares: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../settings/useAddSharedModel", () => ({ useAddSharedModel: () => mocks.addShared }));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setStickyModelSelection: mocks.setSticky }) },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => mocks.cloud }));
vi.mock("../../cloud/accountSessionContext", () => ({
  useAccountSession: () => ({
    isLoaded: true,
    isSignedIn: mocks.signedIn,
    identity: null,
    getToken: async () => null,
  }),
}));
vi.mock("../account/useAccountSignInActions", () => ({
  useAccountSignInActions: () => ({ startSignIn: vi.fn(), startSignUp: vi.fn() }),
}));
vi.mock("../settings/useSharedModelInvites", () => ({
  useSharedModelInvites: () => ({
    pending: mocks.pendingShares,
    refresh: mocks.refreshShares,
    collect: mocks.collectShares,
  }),
}));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { formatModelShareCode } from "../settings/modelShareCode";
import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.cloud = false;
  mocks.signedIn = false;
  mocks.pendingShares = [];
  mocks.refreshShares.mockResolvedValue(undefined);
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it("enters the workspace after a partial import and warns after navigation finishes", async () => {
  let finishNavigation = () => {};
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const onDone = vi.fn(() => navigation);
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => finishNavigation());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
  expect(mocks.toast.mock.invocationCallOrder[0]).toBeGreaterThan(
    onDone.mock.invocationCallOrder[0]!,
  );
});

it.each([
  [0, 0, null],
  [29, 0, null],
  [1, 0, null],
  [0, 1, "1 thread could not be imported."],
  [0, 2, "2 threads could not be imported."],
] as const)(
  "finishes setup with %i imported and %i skipped threads",
  async (importedCount, skippedCount, warning) => {
    mocks.importThreads.mockResolvedValue({
      _tag: "Success",
      value: { importedCount, skippedCount },
    });
    const onDone = vi.fn();
    await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
    await click("Continue");
    await click("Continue");
    await click("Continue");
    await click("Import 1 project");
    expect(onDone).toHaveBeenCalledOnce();
    if (warning === null && importedCount > 0) {
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: `Imported ${importedCount} ${importedCount === 1 ? "thread" : "threads"}`,
      });
    } else if (warning === null) {
      expect(mocks.toast).not.toHaveBeenCalled();
    } else {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", description: warning }),
      );
    }
  },
);

it("keeps setup open when saving completion fails and preserves the import warning on retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Do not import projects");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.importThreads).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
});

it("explains partial imports without blocking access to imported work", async () => {
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: {
      importedCount: 12,
      skippedCount: 3,
      skippedReasons: [
        { reason: "import-limit", count: 2 },
        { reason: "modified-history", count: 1 },
      ],
    },
  });
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description:
        "Imported 12 threads. 3 threads could not be imported. 2 reached this import’s limit; retry to continue with the remaining history. 1 had changed since import; the existing sessions were preserved.",
    }),
  );
  const warning = mocks.toast.mock.calls.find(([toast]) => toast.type === "warning")?.[0];
  expect(warning.actionProps.children).toBe("Review Import");
  await act(async () => warning.actionProps.onClick());
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/welcome" });
  expect(mocks.importThreads).toHaveBeenCalledOnce();
});

const shareCode = formatModelShareCode({
  baseUrl: "https://host.example/api/model-share",
  token: "token-123",
  models: ["claude-sonnet-5"],
});

async function pasteShareCode(value: string) {
  const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Share code"]')!;
  expect(field).not.toBeNull();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The start choices carry a line of explanation, so they are found by their title. */
async function choose(title: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.trim().startsWith(title),
  );
  expect(button, `choice ${title}`).toBeDefined();
  await act(async () => button!.click());
}

it("opens on the start choice and lets someone go on to the existing setup", async () => {
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={vi.fn()} />),
  );
  expect(document.body.textContent).toContain("How do you want to start?");
  expect(document.body.textContent).not.toContain("Sign in to my account");
  await choose("Set up my own AI provider");
  expect(document.body.textContent).toContain("Connect your computers");
});

it("adds a shared model from a pasted code and starts a thread on it", async () => {
  mocks.addShared.mockResolvedValue({
    ok: true,
    instanceId: "claudeAgent_shared_claude_sonnet_5",
    displayName: "Shared: claude-sonnet-5",
    models: ["claude-sonnet-5"],
  });
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={onDone} />),
  );
  await choose("I have a share code from someone");
  await pasteShareCode(shareCode);
  expect(document.body.textContent).toContain("Found this model: claude-sonnet-5");
  await click("Add Shared Model");
  expect(mocks.addShared).toHaveBeenCalledWith(shareCode);
  expect(document.body.textContent).toContain("You’re all set");
  await click("Start Chatting");
  expect(mocks.setSticky).toHaveBeenCalledWith({
    instanceId: "claudeAgent_shared_claude_sonnet_5",
    model: "claude-sonnet-5",
  });
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
});

it("explains a code that cannot be used without calling the server", async () => {
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={vi.fn()} />),
  );
  await choose("I have a share code from someone");
  await pasteShareCode("not a code");
  await click("Add Shared Model");
  expect(document.body.textContent).toContain("That is not a share code.");
  expect(mocks.addShared).not.toHaveBeenCalled();
});

it("keeps the paste screen open with the reason when saving fails", async () => {
  mocks.addShared.mockResolvedValue({
    ok: false,
    message: "Only an administrator can add models.",
  });
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={vi.fn()} />),
  );
  await choose("I have a share code from someone");
  await pasteShareCode(shareCode);
  await click("Add Shared Model");
  expect(document.body.textContent).toContain("Only an administrator can add models.");
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("offers a model that was shared with the signed-in account and starts a thread on it", async () => {
  mocks.cloud = true;
  mocks.signedIn = true;
  mocks.pendingShares = [{ inviteId: "invite-1", label: "Ryan's MacBook", models: ["qwen38"] }];
  mocks.collectShares.mockResolvedValue([
    {
      instanceId: "claudeAgent_shared_qwen38",
      displayName: "Shared: qwen38",
      label: "Ryan's MacBook",
      models: ["qwen38"],
    },
  ]);
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={onDone} />),
  );
  expect(document.body.textContent).toContain("A model was shared with you");
  expect(document.body.textContent).toContain("Ryan's MacBook shared qwen38.");
  // Nothing is added until they choose to continue, and the toast is left to this screen.
  expect(mocks.collectShares).not.toHaveBeenCalled();
  await choose("A model was shared with you");
  expect(mocks.collectShares).toHaveBeenCalledWith({ notify: false });
  expect(mocks.setSticky).toHaveBeenCalledWith({
    instanceId: "claudeAgent_shared_qwen38",
    model: "qwen38",
  });
  expect(onDone).toHaveBeenCalledOnce();
});

it("shows no shared-model choice when nothing was shared, or when signed out", async () => {
  mocks.cloud = true;
  mocks.signedIn = true;
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={vi.fn()} />),
  );
  expect(document.body.textContent).toContain("How do you want to start?");
  expect(document.body.textContent).not.toContain("A model was shared with you");
});

it("says so and stays put when the shared model could not be added", async () => {
  mocks.cloud = true;
  mocks.signedIn = true;
  mocks.pendingShares = [{ inviteId: "invite-1", label: "Ryan", models: ["qwen38"] }];
  mocks.collectShares.mockResolvedValue([]);
  const onDone = vi.fn();
  await act(async () =>
    root.render(<WelcomeWizard localAvailable offerStartChoice onDone={onDone} />),
  );
  await choose("A model was shared with you");
  expect(document.body.textContent).toContain("That model could not be added.");
  expect(onDone).not.toHaveBeenCalled();
});
