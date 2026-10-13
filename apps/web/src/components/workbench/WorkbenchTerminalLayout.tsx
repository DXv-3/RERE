import { useRef, type ReactNode } from "react";
import { useWorkbenchStore } from "./workbenchStore";
import { reconcileLayout, resizePanes, swapPanes, type PaneLayout } from "./workspaceLayout";

export function WorkbenchTerminalLayout({
  layoutKey,
  ids,
  direction,
  label,
  children,
}: {
  layoutKey: string;
  ids: string[];
  direction: PaneLayout["direction"];
  label: (id: string) => string;
  children: (id: string) => ReactNode;
}) {
  const saved = useWorkbenchStore((state) => state.layouts[layoutKey]);
  const save = useWorkbenchStore((state) => state.saveLayout);
  const layout = reconcileLayout(ids, saved, direction);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<string | null>(null);
  const resize = useRef<{
    layout: PaneLayout;
    start: number;
    span: number;
    first: string;
    second: string;
    pointerId: number;
  } | null>(null);
  const commit = (next: PaneLayout) => save(layoutKey, next);
  const vertical = layout.direction === "vertical";
  const tracks = layout.order.map((id) => `minmax(0, ${layout.weights[id]}fr)`).join(" 6px ");
  return (
    <div data-wb-terminal-layout="">
      <div data-wb-layout-toolbar="">
        <input
          aria-label="Layout Name"
          maxLength={60}
          value={layout.name}
          onChange={(e) => commit({ ...layout, name: e.target.value })}
        />
        <span>Saved On This Device</span>
        <button
          type="button"
          onClick={() => commit({ ...layout, direction: vertical ? "horizontal" : "vertical" })}
        >
          {vertical ? "Side By Side" : "Stack"}
        </button>
        <button
          type="button"
          onClick={() =>
            commit({
              ...layout,
              weights: Object.fromEntries(ids.map((id) => [id, 1 / ids.length])),
            })
          }
        >
          Tidy
        </button>
      </div>
      <div
        ref={grid}
        data-wb-pane-grid=""
        style={vertical ? { gridTemplateRows: tracks } : { gridTemplateColumns: tracks }}
      >
        {ids.map((id) => {
          const position = layout.order.indexOf(id);
          return (
            <section
              key={id}
              data-wb-terminal-pane=""
              aria-label={layout.labels[id] || label(id)}
              style={
                vertical
                  ? { gridRow: position * 2 + 1, gridColumn: 1 }
                  : { gridColumn: position * 2 + 1, gridRow: 1 }
              }
              onDragOver={(e) => {
                if (drag.current) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!drag.current) return;
                e.preventDefault();
                commit(swapPanes(layout, drag.current, id));
                drag.current = null;
              }}
            >
              <header data-wb-pane-heading="">
                <button
                  type="button"
                  draggable
                  aria-label={`Drag ${layout.labels[id] || label(id)} To Swap`}
                  onDragStart={(e) => {
                    drag.current = id;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", id);
                  }}
                  onDragEnd={() => {
                    drag.current = null;
                  }}
                >
                  ⠿
                </button>
                <input
                  aria-label={`Name For ${label(id)}`}
                  maxLength={60}
                  value={layout.labels[id] ?? label(id)}
                  onChange={(e) =>
                    commit({ ...layout, labels: { ...layout.labels, [id]: e.target.value } })
                  }
                />
                <select
                  aria-label={`Move ${layout.labels[id] || label(id)}`}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) commit(swapPanes(layout, id, e.target.value));
                  }}
                >
                  <option value="">Move</option>
                  {layout.order
                    .filter((other) => other !== id)
                    .map((other) => (
                      <option key={other} value={other}>
                        Swap With {layout.labels[other] || label(other)}
                      </option>
                    ))}
                </select>
              </header>
              <div data-wb-terminal-content="">{children(id)}</div>
            </section>
          );
        })}
        {layout.order.slice(0, -1).map((first, index) => {
          const second = layout.order[index + 1]!;
          return (
            <div
              key={`resize:${first}:${second}`}
              role="separator"
              tabIndex={0}
              data-wb-pane-separator=""
              aria-label={`Resize ${layout.labels[first] || label(first)}`}
              aria-orientation={vertical ? "horizontal" : "vertical"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(layout.weights[first]! * 100)}
              style={
                vertical
                  ? { gridRow: index * 2 + 2, gridColumn: 1, cursor: "row-resize" }
                  : { gridColumn: index * 2 + 2, gridRow: 1, cursor: "col-resize" }
              }
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const bounds = grid.current?.getBoundingClientRect();
                if (!bounds) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                resize.current = {
                  layout,
                  first,
                  second,
                  start: vertical ? e.clientY : e.clientX,
                  span: Math.max(
                    1,
                    (vertical ? bounds.height : bounds.width) - (ids.length - 1) * 6,
                  ),
                  pointerId: e.pointerId,
                };
              }}
              onPointerMove={(e) => {
                const current = resize.current;
                if (current?.pointerId !== e.pointerId) return;
                commit(
                  resizePanes(
                    current.layout,
                    current.first,
                    current.second,
                    ((vertical ? e.clientY : e.clientX) - current.start) / current.span,
                  ),
                );
              }}
              onPointerUp={(e) => {
                resize.current = null;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onPointerCancel={() => {
                resize.current = null;
              }}
              onLostPointerCapture={() => {
                resize.current = null;
              }}
              onKeyDown={(e) => {
                const negative = vertical ? "ArrowUp" : "ArrowLeft";
                const positive = vertical ? "ArrowDown" : "ArrowRight";
                if (e.key !== negative && e.key !== positive) return;
                e.preventDefault();
                commit(
                  resizePanes(
                    layout,
                    first,
                    second,
                    (e.key === negative ? -1 : 1) * (e.shiftKey ? 0.1 : 0.025),
                  ),
                );
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
