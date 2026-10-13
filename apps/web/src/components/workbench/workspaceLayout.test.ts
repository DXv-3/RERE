import { describe, expect, it } from "vite-plus/test";
import {
  arrangeGrid,
  moveGridPane,
  nudgeGridPane,
  swapGridPanes,
  byUrgency,
  paneActivity,
  reconcileGrid,
  reconcileLayout,
  resizeGridColumns,
  resizeGridRows,
  resizePanes,
  swapPanes,
} from "./workspaceLayout";

describe("terminal presentation keeps resource identity", () => {
  it("keeps surviving panes in their saved order and never recreates closed resources", () => {
    const layout = reconcileLayout(["a", "b", "new"], {
      order: ["closed", "b", "b", "a"],
      weights: { a: 0.3, b: 0.7 },
      labels: { a: "Tests", closed: "Old" },
    });
    expect(layout.order).toEqual(["b", "a", "new"]);
    expect(layout.labels).toEqual({ a: "Tests" });
    expect(Object.values(layout.weights).reduce((a, b) => a + b)).toBeCloseTo(1);
  });
  it("swaps positions without transferring sizes or names between terminals", () => {
    const layout = reconcileLayout(["a", "b"], {
      labels: { a: "Server", b: "Tests" },
      weights: { a: 0.7, b: 0.3 },
    });
    const moved = swapPanes(layout, "a", "b");
    expect(moved.order).toEqual(["b", "a"]);
    expect(moved.labels).toEqual(layout.labels);
    expect(moved.weights).toEqual(layout.weights);
    expect(layout.order).toEqual(["a", "b"]);
  });
  it("resizes only the adjacent pair and clamps both away from zero", () => {
    const layout = reconcileLayout(["a", "b", "c"]);
    const resized = resizePanes(layout, "a", "b", 2);
    expect(resized.weights.c).toBe(layout.weights.c);
    expect(resized.weights.a! + resized.weights.b!).toBeCloseTo(2 / 3);
    expect(resized.weights.b).toBeGreaterThanOrEqual(0.12);
    expect(resizePanes(layout, "a", "c", 0.1)).toBe(layout);
    expect(resizePanes(layout, "a", "b", Number.NaN)).toBe(layout);
  });
  it("recovers usable sizes from obsolete or invalid saved values", () => {
    const layout = reconcileLayout(["a", "b"], {
      weights: { a: Number.NaN, b: -2 },
      direction: "vertical",
    });
    expect(layout.weights).toEqual({ a: 0.5, b: 0.5 });
    expect(layout.direction).toBe("vertical");
    expect(swapPanes(layout, "missing", "a")).toBe(layout);
  });
});

describe("grid layout", () => {
  it("fills three columns before starting a new row and drops closed panes", () => {
    const grid = reconcileGrid(["a", "b", "c", "d"]);
    expect(grid.rows).toEqual([["a", "b", "c"], ["d"]]);
    const next = reconcileGrid(["a", "c", "d", "e"], grid);
    expect(next.rows).toEqual([
      ["a", "c"],
      ["d", "e"],
    ]);
    expect(reconcileGrid(["d"], next).rows).toEqual([["d"]]);
  });

  it("ignores malformed saved layouts", () => {
    const grid = reconcileGrid(["a", "b"], {
      rows: [["a", "a", "ghost"], "bad" as never],
      rowWeights: [Number.NaN],
      weights: { a: -4 },
    });
    expect(grid).toEqual({ rows: [["a", "b"]], rowWeights: [1], weights: { a: 1, b: 1 } });
  });

  it("moves a pane beside or above another pane", () => {
    const grid = reconcileGrid(["a", "b", "c", "d"]);
    expect(moveGridPane(grid, "d", "a", "left").rows).toEqual([["d", "a", "b", "c"]]);
    expect(moveGridPane(grid, "a", "d", "right").rows).toEqual([
      ["b", "c"],
      ["d", "a"],
    ]);
    const stacked = moveGridPane(grid, "c", "a", "top");
    expect(stacked.rows).toEqual([["c"], ["a", "b"], ["d"]]);
    expect(stacked.rowWeights).toHaveLength(3);
    expect(moveGridPane(grid, "a", "a", "top")).toBe(grid);
  });

  it("resizes only adjacent panes and rows, within limits", () => {
    const grid = reconcileGrid(["a", "b", "c", "d"]);
    const wide = resizeGridColumns(grid, "a", "b", 0.1);
    expect(wide.weights.a).toBeCloseTo(1.3);
    expect(wide.weights.b).toBeCloseTo(0.7);
    expect(wide.weights.c).toBe(1);
    expect(resizeGridColumns(grid, "a", "c", 0.1)).toBe(grid);
    expect(resizeGridColumns(grid, "a", "b", 5).weights.b).toBeCloseTo(0.3);
    const tall = resizeGridRows(grid, 0, 0.25);
    expect(tall.rowWeights[0]).toBeCloseTo(1.5);
    expect(tall.rowWeights[1]).toBeCloseTo(0.5);
    expect(resizeGridRows(grid, 1, 0.25)).toBe(grid);
  });
});

describe("grid presets and activity", () => {
  it("re-lays panes evenly without losing or reordering them", () => {
    const grid = resizeGridColumns(reconcileGrid(["a", "b", "c", "d", "e"]), "a", "b", 0.2);
    expect(arrangeGrid(grid, "tile").rows).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    expect(arrangeGrid(grid, "columns").rows).toEqual([["a", "b", "c", "d", "e"]]);
    expect(arrangeGrid(grid, "rows").rows).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    const pairs = arrangeGrid(grid, "pairs");
    expect(pairs.rows).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(pairs.weights.a).toBe(1);
    expect(pairs.rowWeights).toEqual([1, 1, 1]);
  });

  it("lists the sessions that want the user first and keeps ties in place", () => {
    const rows = (["shell", "working", "idle", "needs-you", "ended", "working"] as const).map(
      (activity, index) => ({ activity, index }),
    );
    expect(byUrgency(rows).map((row) => `${row.activity}${row.index}`)).toEqual([
      "needs-you3",
      "ended4",
      "working1",
      "working5",
      "idle2",
      "shell0",
    ]);
  });

  it("reports what a terminal is doing", () => {
    expect(paneActivity(undefined)).toBe("starting");
    expect(paneActivity({ status: "running", hasRunningSubprocess: true })).toBe("running");
    expect(paneActivity({ status: "running", hasRunningSubprocess: false })).toBe("shell");
    const reporting = { status: "running", hasRunningSubprocess: true } as const;
    expect(paneActivity({ ...reporting, agentState: "needs-you" })).toBe("needs-you");
    expect(paneActivity({ ...reporting, agentState: "idle" })).toBe("idle");
    expect(paneActivity({ ...reporting, agentState: null })).toBe("running");
    expect(paneActivity({ status: "exited", hasRunningSubprocess: false })).toBe("ended");
    expect(paneActivity({ status: "closed", hasRunningSubprocess: true })).toBe("ended");
  });
});

describe("pane menu moves", () => {
  const layout = {
    rows: [["a", "b"], ["c"]],
    rowWeights: [2, 1],
    weights: { a: 1, b: 3, c: 1 },
  };
  it("swapping exchanges places and the sizes that go with them", () => {
    expect(swapGridPanes(layout, "a", "c")).toEqual({
      rows: [["c", "b"], ["a"]],
      rowWeights: [2, 1],
      weights: { a: 1, b: 3, c: 1 },
    });
    expect(swapGridPanes(layout, "a", "b").weights).toMatchObject({ a: 3, b: 1 });
    expect(swapGridPanes(layout, "a", "missing")).toBe(layout);
  });
  it("moves one step and stops at the edges", () => {
    expect(nudgeGridPane(layout, "a", "right").rows).toEqual([["b", "a"], ["c"]]);
    expect(nudgeGridPane(layout, "a", "left")).toBe(layout);
    expect(nudgeGridPane(layout, "b", "bottom").rows).toEqual([["a"], ["c", "b"]]);
    expect(nudgeGridPane(layout, "c", "top").rows).toEqual([["c", "a", "b"]]);
    // At the top edge a pane that shares its row takes a new row above.
    expect(nudgeGridPane(layout, "b", "top").rows).toEqual([["b"], ["a"], ["c"]]);
    expect(nudgeGridPane(layout, "c", "bottom")).toBe(layout);
  });
});
