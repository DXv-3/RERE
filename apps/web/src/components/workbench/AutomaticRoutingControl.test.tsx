import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, type RoutingPreview } from "@t3tools/contracts";
import { AutomaticRoutingControl } from "./AutomaticRoutingControl";

const { update, navigate } = vi.hoisted(() => ({ update: vi.fn(), navigate: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => update }));

const environmentId = EnvironmentId.make("test");
const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");
const preview: RoutingPreview = {
  checkedAt: "2026-10-03T08:00:00.000Z",
  mode: "shadow",
  automaticExecution: false,
  judge: "local",
  reservePercent: 10,
  recommendedInstanceId: claude,
  ladders: { [codex]: { advanced: "gpt-big" } },
  accounts: [
    {
      instanceId: claude,
      name: "Claude",
      reason: "available",
      remainingPercent: 80,
      quotaCheckedAt: null,
      sharedWith: null,
      ladder: { basic: "haiku", standard: "sonnet", advanced: "opus" },
      models: ["haiku", "sonnet", "opus"].map((slug) => ({ slug, name: slug })),
    },
  ],
  skills: [],
  skillCatalogAvailable: false,
  scorecard: {
    total: 4,
    changed: 1,
    overridden: 0,
    recent: [
      {
        commandId: "command",
        threadId: "thread",
        decidedAt: "2026-10-03T08:00:00.000Z",
        mode: "shadow",
        judge: "local",
        capability: "advanced",
        effort: "high",
        fromInstanceId: claude,
        fromModel: "sonnet",
        fromEffort: null,
        toInstanceId: claude,
        toModel: "opus",
        toEffort: "high",
        applied: false,
        reason: "Local rules: advanced task, high effort.",
        overridden: false,
      },
    ],
  },
};
let renderer: ReactTestRenderer;
const changed = vi.fn();
const text = () => JSON.stringify(renderer.toJSON());
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockResolvedValue({ _tag: "Success", value: {} });
  await act(async () => {
    renderer = create(
      <AutomaticRoutingControl
        environmentId={environmentId}
        preview={preview}
        onChanged={changed}
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const buttons = () => renderer.root.findAllByType("button");
const labelled = (label: string) =>
  buttons().find((button) => [button.props.children].flat().join("") === label)!;

it("shows the last pick and says when it was only a trial", () => {
  expect(text()).toContain("opus · high effort");
  expect(text()).toContain("(not applied)");
});

it("each choice is one settings patch", async () => {
  await act(async () => labelled("Save Usage").props.onClick());
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { routingPreference: "save" } },
  });
  await act(async () => labelled("Off").props.onClick());
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { routingMode: "manual" } },
  });
  const [pacing, skills, trial] = renderer.root.findAllByProps({ type: "checkbox" });
  await act(async () => skills!.props.onChange({ target: { checked: true } }));
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { skillListing: "selected" } },
  });
  await act(async () => pacing!.props.onChange({ target: { checked: false } }));
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { routingPacing: false } },
  });
  // The fixture is in trial mode; unticking it applies picks from now on.
  await act(async () => trial!.props.onChange({ target: { checked: false } }));
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { routingMode: "automatic" } },
  });
  expect(changed).toHaveBeenCalledTimes(5);
});

it("tells the user when usage is ahead of the week", async () => {
  await act(async () =>
    renderer.update(
      <AutomaticRoutingControl
        environmentId={environmentId}
        preview={{ ...preview, pace: { usedPercent: 80, elapsedPercent: 50 } }}
        onChanged={changed}
      />,
    ),
  );
  expect(text()).toContain("80");
  expect(text()).toContain("Auto is using lighter settings to stretch what is left.");
});

it("setting one tier saves only that choice, and Automatic hands it back", async () => {
  const [basic] = renderer.root.findAllByType("select");
  // The worked-out tiers are shown, not saved: they keep following the account's models.
  expect(basic!.props.value).toBe("");
  await act(async () => basic!.props.onChange({ target: { value: "sonnet" } }));
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      patch: {
        routingLadders: { [codex]: { advanced: "gpt-big" }, [claude]: { basic: "sonnet" } },
      },
    },
  });
  await act(async () => basic!.props.onChange({ target: { value: "" } }));
  expect(update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { routingLadders: { [codex]: { advanced: "gpt-big" }, [claude]: {} } } },
  });
});

const withListing = (extra: Partial<RoutingPreview>) =>
  act(async () =>
    renderer.update(
      <AutomaticRoutingControl
        environmentId={environmentId}
        preview={{ ...preview, mode: "automatic", ...extra }}
        onChanged={changed}
      />,
    ),
  );
// JSX interpolation splits a sentence into several text nodes; read them as the page does.
const flatten = (node: unknown): string =>
  typeof node === "string"
    ? node
    : node && typeof node === "object" && "children" in node
      ? ((node as { children: unknown[] | null }).children ?? []).map(flatten).join("")
      : "";
const pageText = () => flatten(renderer.toJSON());

const budget = (spent: number) => ({
  status: "ready" as const,
  timeZone: "America/New_York",
  day: "2026-10-07",
  capMicroUsd: 1_000_000,
  spentMicroUsd: spent,
  heldMicroUsd: 0,
  availableMicroUsd: 1_000_000 - spent,
  unresolvedRequests: 0,
  halted: false,
});

it("says one sentence about skills and points to the Skills page", async () => {
  await withListing({
    skillListing: "selected",
    jevConfigured: true,
    selectionBudget: budget(0),
  });
  expect(pageText()).toContain("Jev picks skills for each message");
  expect(pageText()).toContain("None of them cost tokens until one is used");
  await withListing({ skillListing: "all" });
  expect(pageText()).toContain("Every provider lists its own skills in every session");
});

it("says plainly when only named skills are attached", async () => {
  await withListing({ skillListing: "selected", jevConfigured: false, selectionBudget: budget(0) });
  expect(pageText()).toContain(
    "Jev is not connected, so only skills you name with $ or /name are attached.",
  );
  await withListing({
    skillListing: "selected",
    jevConfigured: true,
    selectionBudget: budget(999_000),
  });
  expect(pageText()).toContain(
    "Today's Jev budget is spent, so only skills you name with $ or /name are attached until it resets at midnight America/New_York.",
  );
});

it("admits which providers still list their own skills", async () => {
  await withListing({ skillListing: "selected", jevConfigured: true });
  expect(pageText()).toContain("Grok stops reading your Claude and Cursor skill folders");
  expect(pageText()).toContain("Cursor, which has no setting for this");
  await withListing({ skillListing: "all" });
  expect(pageText()).not.toContain("Cursor and Grok still list");
});

it("opens the Skills settings page", async () => {
  await withListing({ skillListing: "selected" });
  const open = buttons().find(
    (button) => [button.props.children].flat().join("") === "Open Skills Settings",
  )!;
  await act(async () => open.props.onClick());
  expect(navigate).toHaveBeenCalledWith({ to: "/settings/skills" });
});

it("shows what Jev has spent today next to its daily budget", async () => {
  await withListing({
    skillListing: "selected",
    selectionBudget: {
      status: "ready",
      timeZone: "America/New_York",
      day: "2026-10-06",
      capMicroUsd: 1_000_000,
      spentMicroUsd: 3_100,
      heldMicroUsd: 0,
      availableMicroUsd: 996_900,
      unresolvedRequests: 0,
      halted: false,
    },
  });
  expect(pageText()).toContain("Jev spend today: $0.0031 of $1.00.");
  await withListing({ skillListing: "selected", selectionBudget: { status: "unavailable" } });
  expect(pageText()).not.toContain("Jev spend today");
});

it("says what Auto has saved, net of what Jev cost, and nothing before a kept pick", async () => {
  expect(pageText()).not.toContain("What Auto Has Saved");
  const savings = {
    lighter: { threads: 1, tokens: 316_468, microUsd: 41_452 },
    stronger: { threads: 0, tokens: 0, microUsd: 0 },
    unpricedThreads: 0,
    jevMicroUsd: 140_592,
    since: "2026-10-06T18:25:11.891Z",
  };
  await withListing({ scorecard: { ...preview.scorecard!, savings } });
  expect(pageText()).toContain("316.5K tokens on a lighter model · net −$0.10");
  expect(pageText()).toContain(
    "1 thread moved to a lighter model: 316,468 tokens, $0.04 less at list prices.",
  );
  expect(pageText()).toContain("Jev’s judging has cost $0.14.");
  expect(pageText()).toContain("Token counts are a floor");
  await withListing({
    scorecard: {
      ...preview.scorecard!,
      savings: { ...savings, lighter: { threads: 0, tokens: 0, microUsd: 0 } },
    },
  });
  expect(pageText()).not.toContain("What Auto Has Saved");
});
