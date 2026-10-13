export interface PaneLayout {
  name: string;
  order: string[];
  weights: Record<string, number>;
  labels: Record<string, string>;
  direction: "horizontal" | "vertical";
}

/** Reconcile saved presentation with live resources; never resurrect a closed terminal. */
export function reconcileLayout(
  ids: readonly string[],
  saved?: Partial<PaneLayout>,
  direction: PaneLayout["direction"] = "horizontal",
): PaneLayout {
  const live = [...new Set(ids)];
  const order = [
    ...new Set([
      ...(Array.isArray(saved?.order) ? saved.order.filter((id) => live.includes(id)) : []),
      ...live,
    ]),
  ];
  const weights = Object.fromEntries(
    order.map((id) => {
      const value = saved?.weights?.[id];
      return [
        id,
        typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1_000_000
          ? value
          : 1,
      ];
    }),
  );
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const labels = Object.fromEntries(
    order.flatMap((id) =>
      typeof saved?.labels?.[id] === "string" ? [[id, saved.labels[id].slice(0, 60)]] : [],
    ),
  );
  return {
    name: typeof saved?.name === "string" ? saved.name.slice(0, 60) : "Coding Layout",
    order,
    weights: Object.fromEntries(order.map((id) => [id, weights[id]! / total])),
    labels,
    direction:
      saved?.direction === "vertical" || saved?.direction === "horizontal"
        ? saved.direction
        : direction,
  };
}

export function swapPanes(layout: PaneLayout, source: string, target: string): PaneLayout {
  if (!layout.order.includes(source) || !layout.order.includes(target) || source === target)
    return layout;
  return {
    ...layout,
    order: layout.order.map((id) => (id === source ? target : id === target ? source : id)),
  };
}

/** Only adjacent panes share a resize; all other resource proportions stay unchanged. */
export function resizePanes(
  layout: PaneLayout,
  first: string,
  second: string,
  delta: number,
): PaneLayout {
  if (
    !Number.isFinite(delta) ||
    layout.order.indexOf(second) !== layout.order.indexOf(first) + 1 ||
    !layout.order.includes(first)
  )
    return layout;
  const combined = layout.weights[first]! + layout.weights[second]!;
  const minimum = Math.min(0.12, combined / 3);
  const value = Math.max(minimum, Math.min(combined - minimum, layout.weights[first]! + delta));
  return { ...layout, weights: { ...layout.weights, [first]: value, [second]: combined - value } };
}

/** Rows of panes: each row splits its width by `weights`, rows split the height by `rowWeights`. */
export interface GridLayout {
  rows: string[][];
  rowWeights: number[];
  weights: Record<string, number>;
}
export type GridEdge = "left" | "right" | "top" | "bottom";
const MAX_AUTO_COLUMNS = 3;
const weight = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1_000_000 ? value : 1;

/** Reconcile a saved grid with live panes: closed panes leave, new panes fill the last row, then start a new one. */
export function reconcileGrid(ids: readonly string[], saved?: Partial<GridLayout>): GridLayout {
  const live = new Set(ids);
  const placed = new Set<string>();
  const rows: string[][] = [];
  const rowWeights: number[] = [];
  (Array.isArray(saved?.rows) ? saved.rows : []).forEach((row, index) => {
    if (!Array.isArray(row)) return;
    const kept = row.filter((id) => {
      if (typeof id !== "string" || !live.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    if (!kept.length) return;
    rows.push(kept);
    rowWeights.push(weight(saved?.rowWeights?.[index]));
  });
  for (const id of live) {
    if (placed.has(id)) continue;
    const last = rows.at(-1);
    if (last && last.length < MAX_AUTO_COLUMNS) last.push(id);
    else {
      rows.push([id]);
      rowWeights.push(1);
    }
  }
  return {
    rows,
    rowWeights,
    weights: Object.fromEntries(rows.flat().map((id) => [id, weight(saved?.weights?.[id])])),
  };
}

/** Drop `source` beside `target`: left/right joins the target's row, top/bottom opens a new row. */
export function moveGridPane(
  layout: GridLayout,
  source: string,
  target: string,
  edge: GridEdge,
): GridLayout {
  const all = new Set(layout.rows.flat());
  if (source === target || !all.has(source) || !all.has(target)) return layout;
  const rows: string[][] = [];
  const rowWeights: number[] = [];
  layout.rows.forEach((row, index) => {
    const kept = row.filter((id) => id !== source);
    if (!kept.length) return;
    rows.push(kept);
    rowWeights.push(layout.rowWeights[index] ?? 1);
  });
  const rowIndex = rows.findIndex((row) => row.includes(target));
  const row = rows[rowIndex]!;
  if (edge === "left" || edge === "right") {
    row.splice(row.indexOf(target) + (edge === "right" ? 1 : 0), 0, source);
    return {
      rows,
      rowWeights,
      weights: { ...layout.weights, [source]: layout.weights[target] ?? 1 },
    };
  }
  const at = rowIndex + (edge === "bottom" ? 1 : 0);
  rows.splice(at, 0, [source]);
  rowWeights.splice(at, 0, rowWeights[rowIndex] ?? 1);
  return { rows, rowWeights, weights: { ...layout.weights, [source]: 1 } };
}

/** Exchange two panes' places. Sizes belong to the places, so each pane takes the other's. */
export function swapGridPanes(layout: GridLayout, first: string, second: string): GridLayout {
  const all = new Set(layout.rows.flat());
  if (first === second || !all.has(first) || !all.has(second)) return layout;
  const swap = (id: string) => (id === first ? second : id === second ? first : id);
  return {
    rows: layout.rows.map((row) => row.map(swap)),
    rowWeights: layout.rowWeights,
    weights: {
      ...layout.weights,
      [first]: layout.weights[second] ?? 1,
      [second]: layout.weights[first] ?? 1,
    },
  };
}

/**
 * Move a pane one step: sideways past its neighbour, or into the row above or below.
 * At the top or bottom edge a pane that shares its row gets a new row of its own.
 */
export function nudgeGridPane(layout: GridLayout, id: string, direction: GridEdge): GridLayout {
  const rowIndex = layout.rows.findIndex((row) => row.includes(id));
  if (rowIndex === -1) return layout;
  const row = layout.rows[rowIndex]!;
  const column = row.indexOf(id);
  if (direction === "left" || direction === "right") {
    const neighbour = row[column + (direction === "right" ? 1 : -1)];
    return neighbour ? swapGridPanes(layout, id, neighbour) : layout;
  }
  const targetRow = layout.rows[rowIndex + (direction === "bottom" ? 1 : -1)];
  if (targetRow) {
    const beside = targetRow[Math.min(column, targetRow.length - 1)]!;
    return moveGridPane(layout, id, beside, column >= targetRow.length ? "right" : "left");
  }
  if (row.length === 1) return layout;
  return moveGridPane(
    layout,
    id,
    row.find((other) => other !== id)!,
    direction,
  );
}

function shift(first: number, second: number, delta: number): [number, number] {
  const combined = first + second;
  const minimum = combined * 0.15;
  const value = Math.max(minimum, Math.min(combined - minimum, first + delta));
  return [value, combined - value];
}

/** `delta` is a fraction of the row's width; only the two adjacent panes change. */
export function resizeGridColumns(
  layout: GridLayout,
  first: string,
  second: string,
  delta: number,
): GridLayout {
  const row = layout.rows.find((candidate) => candidate.includes(first));
  if (!row || !Number.isFinite(delta) || row.indexOf(second) !== row.indexOf(first) + 1)
    return layout;
  const total = row.reduce((sum, id) => sum + (layout.weights[id] ?? 1), 0);
  const [a, b] = shift(layout.weights[first] ?? 1, layout.weights[second] ?? 1, delta * total);
  return { ...layout, weights: { ...layout.weights, [first]: a, [second]: b } };
}

/** `delta` is a fraction of the grid's height; only row `index` and the row below change. */
export function resizeGridRows(layout: GridLayout, index: number, delta: number): GridLayout {
  if (!Number.isFinite(delta) || index < 0 || index >= layout.rows.length - 1) return layout;
  const total = layout.rowWeights.reduce((sum, value) => sum + value, 0);
  const [a, b] = shift(layout.rowWeights[index]!, layout.rowWeights[index + 1]!, delta * total);
  const rowWeights = [...layout.rowWeights];
  rowWeights[index] = a;
  rowWeights[index + 1] = b;
  return { ...layout, rowWeights };
}

export const gridPresets = ["tile", "columns", "rows", "pairs"] as const;
export type GridPreset = (typeof gridPresets)[number];

/** Re-lay every pane evenly in a named arrangement, keeping the current reading order. */
export function arrangeGrid(layout: GridLayout, preset: GridPreset): GridLayout {
  const ids = layout.rows.flat();
  if (!ids.length) return layout;
  const columns =
    preset === "columns"
      ? ids.length
      : preset === "rows"
        ? 1
        : preset === "pairs"
          ? 2
          : Math.ceil(Math.sqrt(ids.length));
  const rows: string[][] = [];
  for (let index = 0; index < ids.length; index += columns)
    rows.push(ids.slice(index, index + columns));
  return {
    rows,
    rowWeights: rows.map(() => 1),
    weights: Object.fromEntries(ids.map((id) => [id, 1])),
  };
}

/**
 * `shell` is a bare prompt and `running` a live program that says nothing about
 * itself. `working`, `needs-you` and `idle` are a coding CLI's own report.
 */
export { paneActivity, type PaneActivity } from "@t3tools/shared/codePaneLaunch";
import type { PaneActivity } from "@t3tools/shared/codePaneLaunch";

const urgency: Record<PaneActivity, number> = {
  "needs-you": 0,
  ended: 1,
  working: 2,
  running: 3,
  starting: 4,
  idle: 5,
  shell: 6,
};

/** Orders sessions by how soon they want the user: waiting first, quiet shells last. */
export function byUrgency<Row extends { activity: PaneActivity }>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  return rows.toSorted((left, right) => urgency[left.activity] - urgency[right.activity]);
}
