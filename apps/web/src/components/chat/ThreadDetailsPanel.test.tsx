import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: (props: { panelSection?: string }) =>
    props.panelSection === "pull-requests" ? <i>[pull-requests]</i> : null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => <i>[scheduled]</i>,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => <i>[subagents]</i>,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("offers no repository, editor, scripts or version control without a project", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const props = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      projectless: true,
      environmentId: "environment:thread-details" as EnvironmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: "scratch",
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: true,
      gitCwd: "/tmp/scratch/thread",
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn(),
      onUpdateProjectScript: vi.fn(),
      onDeleteProjectScript: vi.fn(),
    } as unknown as ThreadDetailsPanelProps;

    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.projectScriptsControl).not.toHaveBeenCalled();
    expect(markup).toContain("Nothing attached to this thread yet.");
    expect(markup).not.toContain("Workspace");
    expect(markup).not.toContain("Version Control");
  });

  it("lists scheduled, pull requests, subagents, then the workspace, with the machine last", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const props = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId: "environment:thread-details" as EnvironmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: "my-project",
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd: "/tmp/my-project",
      isGitRepo: true,
      envLocked: false,
      availableEnvironments: [
        {
          environmentId: "environment:thread-details" as EnvironmentId,
          label: "candid-server",
          machine: "server",
        },
      ],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn(),
      onUpdateProjectScript: vi.fn(),
      onDeleteProjectScript: vi.fn(),
    } as unknown as ThreadDetailsPanelProps;

    const markup = renderToStaticMarkup(<ThreadDetailsPanel {...props} />);
    const order = [
      "[scheduled]",
      "[pull-requests]",
      "[subagents]",
      "my-project",
      "data-thread-details-machine",
    ].map((marker) => markup.indexOf(marker));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].toSorted((a, b) => a - b)).toEqual(order);
  });
});
