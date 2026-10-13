import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ModelSelection,
  type RoutingPreview,
} from "@t3tools/contracts";
import { RoutingControl } from "./RoutingControl";

const { preview, refresh, judge, update } = vi.hoisted(() => ({
  preview: vi.fn(),
  refresh: vi.fn(),
  judge: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    routingPreview: "preview",
    refreshProviders: "refresh",
    routingJudge: "judge",
    updateSettings: "update",
  },
  primaryServerSettingsAtom: "settings",
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ routingMode: "manual" }) }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) =>
    name === "preview" ? preview : name === "judge" ? judge : name === "update" ? update : refresh,
}));
vi.mock("../ui/popover", () => ({
  Popover: "popover",
  PopoverTrigger: "trigger",
  PopoverPopup: "popup",
}));

const env = EnvironmentId.make("environment");
const provider = ProviderInstanceId.make("provider");
const value: RoutingPreview = {
  checkedAt: "2026-10-03T08:00:00Z",
  mode: "advisory",
  automaticExecution: false,
  judge: "local",
  reservePercent: 10,
  recommendedInstanceId: null,
  accounts: [],
  skills: [],
  skillCatalogAvailable: true,
};
let renderer: ReactTestRenderer;
let task = "Edit video reels";
let modelSelection: ModelSelection | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const open = (next: boolean) =>
  renderer.root.findByType("popover" as never).props.onOpenChange(next);
const text = () => JSON.stringify(renderer.toJSON());
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  task = "Edit video reels";
  modelSelection = undefined;
  preview.mockResolvedValue({ _tag: "Success", value });
  refresh.mockResolvedValue({ _tag: "Success", value: {} });
  await act(async () => {
    renderer = create(
      <RoutingControl
        environmentId={env}
        instanceId={provider}
        getModelSelection={() => modelSelection}
        cwd="/project"
        getTask={() => task}
        canJudge
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("reads the current draft on opening without refreshing providers or sending it", async () => {
  expect(preview).not.toHaveBeenCalled();
  task = "Make captions for a reel";
  await act(async () => open(true));
  expect(preview).toHaveBeenCalledWith({
    environmentId: env,
    input: { instanceId: provider, cwd: "/project", task },
  });
  expect(refresh).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(text()).toContain("Messages run on the model you pick.");
});
it("checks the current exact model and shows missing evidence without a paid request", async () => {
  modelSelection = {
    instanceId: provider,
    model: "exact-model",
    options: [{ id: "effort", value: "medium" }],
  };
  preview.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...value,
      qualification: {
        instanceId: provider,
        model: "exact-model",
        state: "blocked",
        reasons: ["evidence_missing"],
        checkedAt: value.checkedAt,
        evidenceCheckedAt: null,
        contextTokens: null,
        billing: "unknown",
        automaticExecution: false,
      },
    },
  });
  await act(async () => open(true));
  expect(preview.mock.calls[0]![0].input.modelSelection).toEqual(modelSelection);
  expect(text()).toContain("not qualified for automatic routing");
  expect(text()).toContain("evidence has not been recorded");
  expect(judge).not.toHaveBeenCalled();
});
it("discards a qualification response if the model changes while it is loading", async () => {
  const response = deferred<{ _tag: "Success"; value: RoutingPreview }>();
  modelSelection = { instanceId: provider, model: "before" };
  preview.mockReturnValueOnce(response.promise);
  await act(async () => open(true));
  modelSelection = { instanceId: provider, model: "after" };
  await act(async () => response.resolve({ _tag: "Success", value }));
  expect(text()).toContain("Your model changed");
  expect(text()).not.toContain("Account Allowances");
});
it("ignores a stale response when the panel is closed and reopened", async () => {
  const first = deferred<{ _tag: "Success"; value: RoutingPreview }>();
  preview.mockReturnValueOnce(first.promise);
  await act(async () => open(true));
  await act(async () => open(false));
  await act(async () => open(true));
  await act(async () =>
    first.resolve({
      _tag: "Success",
      value: {
        ...value,
        skills: [{ name: "stale-skill", description: "stale", matchedTerms: [] }],
      },
    }),
  );
  expect(text()).not.toContain("stale-skill");
});
it("refreshes the project catalog only after an explicit refresh", async () => {
  await act(async () => open(true));
  const button = renderer.root.findAllByType("button")[0]!;
  await act(async () => button.props.onClick());
  expect(refresh.mock.calls).toEqual([
    [{ environmentId: env, input: {} }],
    [{ environmentId: env, input: { instanceId: provider, cwd: "/project", fresh: true } }],
  ]);
});
it("keeps a failed request visible without changing manual execution", async () => {
  preview.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => open(true));
  expect(text()).toContain("Your manual model selection still works");
  expect(refresh).not.toHaveBeenCalled();
});

it("shows held budget and a cost overrun without implying Jev is enabled", async () => {
  preview.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...value,
      selectionBudget: {
        status: "ready",
        timeZone: "America/New_York",
        day: "2026-10-03",
        capMicroUsd: 1_000_000,
        spentMicroUsd: 11_000,
        heldMicroUsd: 10_000,
        availableMicroUsd: 0,
        unresolvedRequests: 1,
        halted: true,
      },
    },
  });
  await act(async () => open(true));
  expect(text()).toContain("$0.011");
  expect(text()).toContain("$0.01");
  expect(text()).toContain("awaiting cost reconciliation");
  expect(text()).toContain("Selection spending is stopped");
  expect(text()).toContain("Jev requests are not enabled");
});
it("does not report a full allowance when the ledger cannot be read", async () => {
  preview.mockResolvedValueOnce({
    _tag: "Success",
    value: { ...value, selectionBudget: { status: "unavailable" } },
  });
  await act(async () => open(true));
  expect(text()).toContain("Budget unavailable");
  expect(text()).not.toContain("$1.00");
});

it("shows sub-cent selection charges without rounding them down to zero", async () => {
  preview.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...value,
      selectionBudget: {
        status: "ready",
        timeZone: "America/New_York",
        day: "2026-10-03",
        capMicroUsd: 1_000_000,
        spentMicroUsd: 20,
        heldMicroUsd: 0,
        availableMicroUsd: 999_980,
        unresolvedRequests: 0,
        halted: false,
      },
    },
  });
  await act(async () => open(true));
  expect(text()).toContain("$0.00002");
});

const ready = {
  ...value,
  jevConfigured: true,
  selectionBudget: {
    status: "ready",
    timeZone: "America/New_York",
    day: "2026-10-03",
    capMicroUsd: 1000000,
    spentMicroUsd: 0,
    heldMicroUsd: 0,
    availableMicroUsd: 1000000,
    unresolvedRequests: 0,
    halted: false,
  },
} as const;
const advice = {
  requestId: "test",
  receiptId: "gen-test",
  model: "typesafe/jev-1.13-20260917",
  costMicroUsd: 26,
  inputTokens: 600,
  capability: "standard",
  effort: "low",
  skillName: null,
  confidence: { capability: 0.94, effort: 0.22, skill: 1 },
} as const;
const ask = () =>
  renderer.root
    .findAllByType("button")
    .find((b) => b.props.children === "Ask Jev")!
    .props.onClick();
it("requires an explicit action, suppresses duplicate clicks and reuses the result on reopening", async () => {
  preview.mockResolvedValue({ _tag: "Success", value: ready });
  const response = deferred<{ _tag: "Success"; value: typeof advice }>();
  judge.mockReturnValueOnce(response.promise);
  await act(async () => open(true));
  expect(judge).not.toHaveBeenCalled();
  await act(async () => {
    ask();
    ask();
  });
  expect(judge).toHaveBeenCalledTimes(1);
  expect(judge.mock.calls[0]![0].input.task).toBe(task);
  await act(async () => response.resolve({ _tag: "Success", value: advice }));
  expect(text()).toContain("Recorded cost");
  expect(text()).toContain("Your model is unchanged");
  expect(text()).toContain("22");
  await act(async () => open(false));
  await act(async () => open(true));
  await act(async () => ask());
  expect(judge).toHaveBeenCalledTimes(1);
});
it("does not display an old paid recommendation after the draft changes", async () => {
  preview.mockResolvedValue({ _tag: "Success", value: ready });
  const response = deferred<{ _tag: "Success"; value: typeof advice }>();
  judge.mockReturnValueOnce(response.promise);
  await act(async () => open(true));
  await act(async () => ask());
  task = "A different task";
  await act(async () => response.resolve({ _tag: "Success", value: advice }));
  expect(text()).toContain("Your draft changed");
  expect(text()).not.toContain("gen-test");
});
it("retains the same request identity after a lost reply", async () => {
  preview.mockResolvedValue({ _tag: "Success", value: ready });
  judge.mockRejectedValueOnce(new Error("offline"));
  await act(async () => open(true));
  await act(async () => ask());
  const first = judge.mock.calls[0]![0].input.requestId;
  expect(text()).toContain("Connection interrupted");
  await act(async () => open(false));
  await act(async () => open(true));
  judge.mockResolvedValueOnce({ _tag: "Success", value: advice });
  await act(async () => ask());
  expect(judge.mock.calls[1]![0].input.requestId).toBe(first);
});

it("invalidates cached advice when the available skill candidates change", async () => {
  preview.mockResolvedValue({ _tag: "Success", value: ready });
  judge.mockResolvedValue({ _tag: "Success", value: advice });
  await act(async () => open(true));
  await act(async () => ask());
  const firstId = judge.mock.calls[0]![0].input.requestId;
  await act(async () => open(false));
  preview.mockResolvedValue({
    _tag: "Success",
    value: {
      ...ready,
      skills: [
        { name: "captions", description: "A new caption skill", matchedTerms: ["captions"] },
      ],
    },
  });
  await act(async () => open(true));
  expect(text()).not.toContain("gen-test");
  await act(async () => ask());
  expect(judge.mock.calls[1]![0].input.requestId).not.toBe(firstId);
});

it("restores advice in a new client without a paid command", async () => {
  preview.mockResolvedValue({
    _tag: "Success",
    value: { ...ready, jevRequest: { requestId: advice.requestId, state: "settled", advice } },
  });
  await act(async () => open(true));
  expect(text()).toContain("gen-test");
  await act(async () => renderer.unmount());
  await act(async () => {
    renderer = create(
      <RoutingControl
        environmentId={env}
        instanceId={provider}
        cwd="/project"
        getTask={() => task}
        canJudge
      />,
    );
  });
  await act(async () => open(true));
  expect(text()).toContain("gen-test");
  await act(async () => ask());
  expect(judge).not.toHaveBeenCalled();
});
it("never creates a fresh paid request when recovery is unavailable or unresolved", async () => {
  for (const jevRequest of [
    null,
    { requestId: "jev1_held", state: "dispatched", advice: null },
  ] as const) {
    preview.mockResolvedValue({ _tag: "Success", value: { ...ready, jevRequest } });
    await act(async () => open(true));
    await act(async () => ask());
    expect(judge).not.toHaveBeenCalled();
  }
  expect(text()).toContain("will not be sent again");
});
it("uses the server identity and refuses a changed draft until refreshed", async () => {
  preview.mockResolvedValue({
    _tag: "Success",
    value: { ...ready, jevRequest: { requestId: "jev1_server", state: "new", advice: null } },
  });
  await act(async () => open(true));
  task = "A changed draft";
  await act(async () => ask());
  expect(judge).not.toHaveBeenCalled();
  expect(text()).toContain("Refresh Routing");
  await act(async () => open(true));
  judge.mockRejectedValueOnce(new Error("lost response"));
  await act(async () => ask());
  expect(judge.mock.calls[0]![0].input.requestId).toBe("jev1_server");
});
