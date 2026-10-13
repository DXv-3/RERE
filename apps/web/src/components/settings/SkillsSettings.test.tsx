import { act, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ManagedSkillSummary, type SkillPackSummary } from "@t3tools/contracts";
import { SkillsSettings } from "./SkillsSettings";

const commands = vi.hoisted(() => ({
  managedSkillsList: vi.fn(),
  managedSkillsSetEnabled: vi.fn(),
  managedSkillsSyncLibrary: vi.fn(),
  managedSkillsAdmit: vi.fn(),
  managedSkillsAdmitStarters: vi.fn(),
  routingPreview: vi.fn(),
  updateSettings: vi.fn(),
  skillPacksList: vi.fn(),
  skillPacksChange: vi.fn(),
  // One call carries every pack action; the tests keep one mock per kind of action.
  skillPacksRun: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: Object.fromEntries(Object.keys(commands).map((name) => [name, name])),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: keyof typeof commands) => commands[name],
}));

// The real layout reads router state; the page's own content is what is under test.
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: ReactNode;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      {title} {description} {status} {control} {children}
    </div>
  ),
}));
// Base UI's tooltip needs a browser window; its trigger is the button under test.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
  TooltipPopup: () => null,
}));
vi.mock("./FoldedSettingsSection", () => ({ FoldedSettingsSection: () => null }));

const entry = (id: string, source: string, path: string, enabled: boolean): ManagedSkillSummary =>
  ({
    id,
    revision: "a".repeat(64),
    name: id,
    description: `Does ${id}`,
    source,
    sourceRevision: "1",
    sourceSha256: "a".repeat(64),
    reviewNote: "",
    permissions: [],
    projectRoots: [],
    dependencies: [{ path, executable: false }],
    stages: [],
    enabled,
  }) as ManagedSkillSummary;
const catalog = [
  entry("ship-it", "local-library:ship-it/SKILL.md", "~/.claude/skills/ship-it/SKILL.md", true),
  entry(
    "plugin-gcloud-tools-setup",
    "plugin-library:gcloud-tools/setup/SKILL.md",
    "~/.claude/plugins/cache/m/gcloud-tools/1/skills/setup/SKILL.md",
    true,
  ),
  entry(
    "ads-angles",
    "local-library:ads-angles/SKILL.md",
    "~/.codewrench/skill-library/ads/angles/SKILL.md",
    false,
  ),
  entry(
    "ads-offers",
    "local-library:ads-offers/SKILL.md",
    "~/.codewrench/skill-library/ads/offers/SKILL.md",
    false,
  ),
];
const routing = {
  mode: "automatic",
  skillListing: "selected",
  jevConfigured: true,
  selectionBudget: {
    status: "ready",
    timeZone: "America/New_York",
    day: "2026-10-06",
    capMicroUsd: 1_000_000,
    spentMicroUsd: 0,
    heldMicroUsd: 0,
    availableMicroUsd: 1_000_000,
    unresolvedRequests: 0,
    halted: false,
  },
};
const flatten = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(flatten).join(" ")
      : node && typeof node === "object" && "children" in node
        ? ((node as { children: unknown[] | null }).children ?? []).map(flatten).join("")
        : "";
const videoPack = (change: Partial<SkillPackSummary> = {}): SkillPackSummary => ({
  id: "video-and-motion",
  title: "Video and Motion",
  description: "Make videos with agents.",
  sources: [
    {
      id: "gsap",
      repositoryUrl: "https://github.com/greensock/gsap-skills",
      commit: "a".repeat(40),
      license: "MIT",
      installedCommit: null,
    },
  ],
  installed: false,
  skillCount: 8,
  updateAvailable: false,
  ...change,
});
const mac = { environmentId: EnvironmentId.make("mac"), label: "MacBook Air" };
const server = { environmentId: EnvironmentId.make("server"), label: "candid-server" };
let renderer: ReactTestRenderer;
const mount = async (machines: readonly { environmentId: EnvironmentId; label: string }[]) => {
  await act(async () => {
    renderer = create(<SkillsSettings machines={machines} />);
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.managedSkillsList.mockResolvedValue({ _tag: "Success", value: catalog });
  commands.routingPreview.mockResolvedValue({ _tag: "Success", value: routing });
  commands.managedSkillsSetEnabled.mockResolvedValue({ _tag: "Success", value: undefined });
  commands.managedSkillsSyncLibrary.mockResolvedValue({
    _tag: "Success",
    value: { found: 4, added: 0, skipped: 0, enabled: 4 },
  });
  commands.updateSettings.mockResolvedValue({ _tag: "Success", value: undefined });
  commands.skillPacksList.mockResolvedValue({ _tag: "Success", value: [videoPack()] });
  commands.skillPacksRun.mockImplementation(
    async (request: { readonly input: { readonly action: string } }) => {
      if (request.input.action === "list") return commands.skillPacksList(request);
      if (request.input.action === "admit-starters") {
        return commands.managedSkillsAdmitStarters(request);
      }
      // The call answers with a list; the per-action mocks answer with the one changed pack.
      const result = await commands.skillPacksChange(request);
      return result?._tag === "Success" ? { ...result, value: [result.value] } : result;
    },
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const text = () => flatten(renderer.toJSON());
const press = async (label: string) => {
  const button = renderer.root
    .findAll((node) => typeof node.props.onClick === "function")
    .find(
      (node) =>
        node.props["aria-label"] === label ||
        flatten(node.props.children).replace(/\s+/g, " ").trim() === label,
    )!;
  await act(async () => button.props.onClick());
};
const calledIds = (name: "managedSkillsSetEnabled") =>
  commands[name].mock.calls.map(([call]) => `${call.environmentId}:${call.input.id}`);

describe("one machine", () => {
  beforeEach(() => mount([mac]));

  it("states the mode with a real count and groups skills by where they came from", () => {
    expect(text()).toContain(
      "Jev picks from your 2 skills for each message. None of them cost tokens until one is used.",
    );
    expect(text()).toContain("My Skills · 1");
    expect(text()).toContain("Plugin Skills · 1");
    expect(text()).toContain("Downloaded · 2");
  });

  it("has no sync buttons, source filter or downloaded-skills rule", () => {
    expect(text()).not.toContain("Sync");
    expect(text()).not.toContain("Turn On All");
    expect(text()).not.toContain("Let Providers List Their Own");
    expect(text()).not.toContain("a downloaded skill runs");
    expect(text()).not.toContain("machines");
  });

  it("labels each skill's switch Available", () => {
    const labels = renderer.root
      .findAll((node) => typeof node.props["aria-label"] === "string")
      .map((node) => node.props["aria-label"] as string);
    expect(labels).toContain("Available: ship-it");
    expect(labels).not.toContain("Show Off Only");
  });

  it("turns every skill on with Turn All On, downloaded ones included", async () => {
    await press("Turn All On");
    expect(calledIds("managedSkillsSetEnabled")).toEqual(["mac:ads-angles", "mac:ads-offers"]);
    expect(text()).toContain("Turned 2 skills on.");
  });

  it("turns a whole group on with one press, and the groups already on offer to turn off", async () => {
    await press("Turn Group On");
    expect(calledIds("managedSkillsSetEnabled")).toEqual(["mac:ads-angles", "mac:ads-offers"]);
    expect(text()).toContain("Turned 2 skills on.");
    expect(text()).toContain("Turn Group Off");
  });

  it("filters by search words", async () => {
    const input = renderer.root.findByProps({ "aria-label": "Find a skill" });
    await act(async () => input.props.onChange({ target: { value: "offers" } }));
    await press("Turn All Off");
    expect(calledIds("managedSkillsSetEnabled")).toEqual([]);
    await press("Turn All On");
    expect(calledIds("managedSkillsSetEnabled")).toEqual(["mac:ads-offers"]);
  });

  it("refreshes by syncing and turning on, then reads the list again", async () => {
    await press("Refresh");
    expect(commands.managedSkillsSyncLibrary).toHaveBeenCalledWith({
      environmentId: mac.environmentId,
      input: { enable: true },
    });
    expect(commands.managedSkillsList).toHaveBeenCalledTimes(2);
  });

  it("says so when providers list their own skills, and the switch turns the mode on", async () => {
    commands.routingPreview.mockResolvedValue({
      _tag: "Success",
      value: { ...routing, skillListing: "all" },
    });
    await act(async () => renderer.unmount());
    await mount([mac]);
    expect(text()).toContain("Every provider lists all of its own skills in every session");
    const toggle = renderer.root.findByProps({
      "aria-label": "Load Only The Skills Each Message Needs",
    });
    await act(async () => toggle.props.onCheckedChange(true));
    expect(commands.updateSettings).toHaveBeenCalledWith({
      environmentId: mac.environmentId,
      input: { patch: { skillListing: "selected" } },
    });
  });
});

describe("two machines", () => {
  const serverCatalog = [
    entry("ship-it", "local-library:ship-it/SKILL.md", "~/.claude/skills/ship-it/SKILL.md", false),
  ];
  beforeEach(() => {
    commands.managedSkillsList.mockImplementation(async ({ environmentId }) => ({
      _tag: "Success",
      value: environmentId === server.environmentId ? serverCatalog : catalog,
    }));
  });

  it("shows each machine's count and notes a skill that is on for only one", async () => {
    await mount([mac, server]);
    expect(text()).toContain("MacBook Air · 2 available");
    expect(text()).toContain("candid-server · 0 available");
    expect(text()).toContain("ship-it · on 1 of 2 machines");
  });

  it("applies the mode switch to every machine, and a switch to the machines that have the skill", async () => {
    await mount([mac, server]);
    const toggle = renderer.root.findByProps({
      "aria-label": "Load Only The Skills Each Message Needs",
    });
    await act(async () => toggle.props.onCheckedChange(false));
    expect(commands.updateSettings.mock.calls.map(([call]) => call.environmentId)).toEqual([
      "mac",
      "server",
    ]);
    const skill = renderer.root.findByProps({ "aria-label": "Available: ship-it" });
    await act(async () => skill.props.onCheckedChange(true));
    expect(calledIds("managedSkillsSetEnabled")).toEqual(["server:ship-it"]);
  });

  it("reports the machine that failed and still changes the other", async () => {
    await mount([mac, server]);
    commands.managedSkillsSetEnabled.mockImplementation(async ({ environmentId }) =>
      environmentId === mac.environmentId
        ? { _tag: "Success", value: undefined }
        : {
            _tag: "Failure",
            cause: { _tag: "Fail", failure: { _tag: "ManagedSkillError", reason: "storage" } },
          },
    );
    await press("Turn All On");
    expect(
      commands.managedSkillsSetEnabled.mock.calls.map(([call]) => call.environmentId),
    ).toContain("mac");
    expect(text()).toContain("candid-server:");
  });
});

describe("skill packs", () => {
  beforeEach(() => mount([mac]));
  const buttons = () =>
    renderer.root
      .findAll((node) => typeof node.props.onClick === "function")
      .map((node) => flatten(node.props.children).trim());

  it("lists each pack with its count, source link, license and the permissions warning", () => {
    expect(text()).toContain("Skill Packs");
    expect(text()).toContain("Video and Motion");
    expect(text()).toContain("8 skills");
    expect(text()).toContain("greensock/gsap-skills");
    expect(text()).toContain("(MIT)");
    expect(text()).toContain("Downloaded skills run with your agent's permissions.");
    const link = renderer.root.findByProps({ href: "https://github.com/greensock/gsap-skills" });
    expect(link.props.rel).toBe("noreferrer");
    expect(buttons()).toContain("Install");
    expect(buttons()).not.toContain("Remove");
  });

  it("installs by pack id only, then reads the list again", async () => {
    commands.skillPacksChange.mockResolvedValue({ _tag: "Success", value: videoPack() });
    await press("Install");
    expect(commands.skillPacksChange).toHaveBeenCalledWith({
      environmentId: mac.environmentId,
      input: { packId: "video-and-motion", action: "install" },
    });
    expect(commands.managedSkillsList).toHaveBeenCalledTimes(2);
    expect(commands.skillPacksList).toHaveBeenCalledTimes(2);
  });

  it("shows a failed install on the pack's row in plain words", async () => {
    commands.skillPacksChange.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail({ _tag: "SkillPackError", reason: "git_missing" }),
    });
    await press("Install");
    expect(text()).toContain("Git is not installed on this machine");
  });

  it("offers Remove when installed, and Update when the build pins a newer commit", async () => {
    commands.skillPacksList.mockResolvedValue({
      _tag: "Success",
      value: [videoPack({ installed: true })],
    });
    await act(async () => renderer.unmount());
    await mount([mac]);
    expect(text()).toContain("Installed");
    expect(buttons()).toContain("Remove");
    expect(buttons()).not.toContain("Install");
    commands.skillPacksChange.mockResolvedValue({ _tag: "Success", value: videoPack() });
    await press("Remove");
    expect(commands.skillPacksChange).toHaveBeenCalledWith({
      environmentId: mac.environmentId,
      input: { packId: "video-and-motion", action: "remove" },
    });
    commands.skillPacksList.mockResolvedValue({
      _tag: "Success",
      value: [videoPack({ installed: true, updateAvailable: true })],
    });
    await act(async () => renderer.unmount());
    await mount([mac]);
    expect(buttons()).toContain("Update");
  });
});
