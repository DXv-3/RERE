import { expect, it } from "vite-plus/test";
import { mediaLayout, readCustomTools, restoreLayout, snapshotLayout } from "./codeLayouts";
import { launchCommand } from "./codePaneLaunch";

const panes = [
  { id: "a", kind: "claude" as const, label: "Planner", model: { slug: "opus", name: "Opus" } },
  { id: "b", kind: "codex" as const, label: "Builder" },
  { id: "c", kind: "custom" as const, label: "Aider", command: "aider --watch" },
];
const layout = { rows: [["a"], ["c", "b"]], rowWeights: [2, 1], weights: { a: 1, b: 3, c: 1 } };

it("a saved layout reopens the same arrangement on fresh sessions", () => {
  const saved = snapshotLayout("Team", panes, layout, true);
  expect(JSON.stringify(saved)).not.toContain('"id"');
  let next = 0;
  const restored = restoreLayout(saved, () => `new-${next++}`);
  expect(restored.panes).toEqual([
    { ...panes[0], id: "new-0" },
    { ...panes[1], id: "new-1" },
    { ...panes[2], id: "new-2" },
  ]);
  expect(restored.layout).toEqual({
    rows: [["new-0"], ["new-2", "new-1"]],
    rowWeights: [2, 1],
    weights: { "new-0": 1, "new-1": 3, "new-2": 1 },
  });
});

it("a layout that names a missing pane still opens the panes it has", () => {
  const restored = restoreLayout(
    { ...mediaLayout, layout: { rows: [["0", "7"]], rowWeights: [1], weights: {} } },
    () => "only",
  );
  expect(restored.layout.rows).toEqual([["only"]]);
});

it("custom tools keep only a name and a single-line command", () => {
  expect(
    readCustomTools([
      { name: "Aider", command: "aider", extra: true },
      { name: "", command: "x" },
      { name: "Two Lines", command: "a\nb" },
      "junk",
    ]),
  ).toEqual([{ name: "Aider", command: "aider" }]);
  expect(launchCommand("custom", undefined, "aider --watch")).toBe("aider --watch");
  expect(launchCommand("custom", undefined, "a\rb")).toBeNull();
});
