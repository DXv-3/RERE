import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ManagedSkillCandidate } from "@t3tools/contracts";
import { ManagedSkillsControl } from "./ManagedSkillsControl";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { managedSkillsLoad: "load" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => ({ load })[name],
}));
const skill: ManagedSkillCandidate = {
  id: "review",
  name: "Reel Review",
  description: "Review video reels",
  revision: "a".repeat(64),
  source: "local",
  sourceRevision: "1",
  sourceSha256: "b".repeat(64),
  reviewNote: "Reviewed",
  enabled: true,
  permissions: [],
  projectRoots: [],
  dependencies: [],
  stages: [{ stage: "review", utf8Bytes: 10 }],
  matchedTerms: ["reel"],
  missingDependencies: [],
};
let renderer: ReactTestRenderer;
const onLoad = vi.fn(() => "added" as const);
const onManage = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(
      <ManagedSkillsControl
        environmentId={EnvironmentId.make("qa")}
        cwd="/project"
        candidates={[skill]}
        available
        onLoad={onLoad}
        onManage={onManage}
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("does not load instructions until an explicit stage request and never submits a task", async () => {
  expect(load).not.toHaveBeenCalled();
  const result = {
    id: skill.id,
    revision: skill.revision,
    stage: "review",
    instructions: "Review it.",
    utf8Bytes: 10,
    tokenCount: null,
    permissions: [],
  };
  load.mockResolvedValue({ _tag: "Success", value: result });
  const stageButton = renderer.root
    .findAllByType("button")
    .find((b) => JSON.stringify(b.props.children).includes("review"))!;
  await act(async () => stageButton.props.onClick());
  expect(load.mock.calls[0]![0].input).toEqual({
    id: skill.id,
    revision: skill.revision,
    stage: "review",
    cwd: "/project",
  });
  expect(onLoad).toHaveBeenCalledWith(result);
  expect(JSON.stringify(renderer.toJSON())).toContain("Actual model tokens have not been measured");
});
