import type { CodePane } from "./workbenchStore";
import { type GridLayout, reconcileGrid } from "./workspaceLayout";

type SavedPane = Omit<CodePane, "id">;
/** A named arrangement of panes. Opening one starts fresh sessions; nothing is resumed. */
export interface SavedCodeLayout {
  name: string;
  panes: SavedPane[];
  /** Pane ids here are positions in `panes` ("0", "1", …), not terminal ids. */
  layout: GridLayout;
  browserOpen: boolean;
  /** Address the browser panel offers first when this layout opens. */
  browserUrl?: string;
}
export interface CustomCodeTool {
  name: string;
  command: string;
}

export const MAX_SAVED_LAYOUTS = 12;
export const MAX_CUSTOM_TOOLS = 12;

/** Built in: an agent beside the HyperFrames preview. Connects no generation provider. */
export const mediaLayout: SavedCodeLayout = {
  name: "Media",
  panes: [{ kind: "claude", label: "Claude Code" }],
  layout: { rows: [["0"]], rowWeights: [1], weights: { "0": 1 } },
  browserOpen: true,
  browserUrl: "http://localhost:3002",
};

export function snapshotLayout(
  name: string,
  panes: readonly CodePane[],
  layout: GridLayout,
  browserOpen: boolean,
): SavedCodeLayout {
  const position = new Map(panes.map((pane, index) => [pane.id, String(index)]));
  const rename = (id: string) => position.get(id) ?? id;
  return {
    name,
    // A layout starts fresh sessions in the project folder; a pane's worktree is not part of it.
    panes: panes.map(({ id: _id, worktree: _worktree, ...pane }) => pane),
    layout: {
      rows: layout.rows.map((row) => row.map(rename)),
      rowWeights: [...layout.rowWeights],
      weights: Object.fromEntries(
        Object.entries(layout.weights).map(([id, weight]) => [rename(id), weight]),
      ),
    },
    browserOpen,
  };
}

export function restoreLayout(
  saved: SavedCodeLayout,
  makeId: () => string,
): { panes: CodePane[]; layout: GridLayout } {
  const panes = saved.panes.map((pane) => ({ ...pane, id: makeId() }));
  const id = (position: string) => panes[Number(position)]?.id ?? position;
  return {
    panes,
    // Reconciling drops any position the saved grid names that has no pane.
    layout: reconcileGrid(
      panes.map((pane) => pane.id),
      {
        rows: saved.layout.rows.map((row) => row.map(id)),
        rowWeights: saved.layout.rowWeights,
        weights: Object.fromEntries(
          Object.entries(saved.layout.weights).map(([position, weight]) => [id(position), weight]),
        ),
      },
    ),
  };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function readCustomTools(value: unknown): CustomCodeTool[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (tool): tool is CustomCodeTool =>
        text(tool?.name, 40) && text(tool?.command, 500) && !/[\r\n]/.test(tool.command),
    )
    .map(({ name, command }) => ({ name, command }))
    .slice(0, MAX_CUSTOM_TOOLS);
}
