import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type RoutingDecision } from "@t3tools/contracts";
import { attachedSkills, judgedBy, RoutedPickLine, useRoutingPicks } from "./routingPicks";

const claude = ProviderInstanceId.make("claude");
const decision = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
  commandId: "command",
  threadId: "thread",
  messageId: "message-1",
  decidedAt: "2026-10-03T08:00:00.000Z",
  mode: "automatic",
  judge: "jev",
  capability: "advanced",
  effort: "high",
  fromInstanceId: claude,
  fromModel: "sonnet",
  fromEffort: null,
  toInstanceId: claude,
  toModel: "opus",
  toEffort: "high",
  applied: true,
  reason: "Jev: high effort.",
  overridden: false,
  ...overrides,
});
let renderer: ReactTestRenderer | undefined;
const render = async (value: RoutingDecision) => {
  useRoutingPicks.setState({ picks: { [value.messageId!]: value } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<RoutedPickLine messageId={value.messageId!} />);
  });
  // JSX interpolation splits one sentence into several text nodes; read them as the page does.
  const flatten = (node: unknown): string =>
    typeof node === "string"
      ? node
      : node && typeof node === "object" && "children" in node
        ? ((node as { children: unknown[] | null }).children ?? []).map(flatten).join("")
        : "";
  return flatten(renderer!.toJSON());
};
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useRoutingPicks.setState({ picks: {} });
  vi.unstubAllGlobals();
});

it("says who judged the message and which skills were attached", async () => {
  const text = await render(
    decision({ skillName: "managed:go", skillNames: ["managed:go", "managed:premortem"] }),
  );
  expect(text).toContain("Judged by Jev");
  expect(text).toContain("Skills: go, premortem");
  // The judge is named once; the reason does not repeat it.
  expect(text).not.toContain("Jev: high effort");
  expect(text).toContain("high effort.");
});

it("calls local picks local rules and shows no skills line when none were attached", async () => {
  const text = await render(decision({ judge: "local", reason: "Local rules: low effort." }));
  expect(text).toContain("Local rules");
  expect(text).not.toContain("Skills:");
  expect(judgedBy({ judge: "reused" })).toBe("Same as the last message");
  expect(attachedSkills({ skillName: "managed:go" })).toEqual(["go"]);
});
