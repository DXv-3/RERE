import { useLocation } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { useThreadShells } from "../../state/entities";
import { parseThreadPath, type RememberedThread } from "./tabMemory";
import { MAX_THREAD_PANES, threadPaneKey, useWorkbenchStore } from "./workbenchStore";
import { reconcileLayout, resizePanes, type PaneLayout } from "./workspaceLayout";
import { openThreadWindow } from "./threadWindow";

const ChatView = lazy(() => import("../ChatView"));
const LAYOUT_KEY = "threads:panes";

function SessionPane({ thread }: { thread: RememberedThread }) {
  const composerRef: ComposerHandleRef = useRef(null);
  return (
    <ComposerHandleContext value={composerRef}>
      <Suspense fallback={<p role="status">Loading session…</p>}>
        <ChatView
          environmentId={thread.environmentId as EnvironmentId}
          threadId={thread.threadId as ThreadId}
          routeKind="server"
          reserveTitleBarControlInset={false}
        />
      </Suspense>
    </ComposerHandleContext>
  );
}

/** Extra sessions share the server but keep independent composers and pane presentation. */
export function ThreadWorkspace({ children, active }: { children: ReactNode; active: boolean }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = parseThreadPath(pathname);
  const shells = useThreadShells();
  const panes = useWorkbenchStore((state) => state.threadPanes);
  const setPanes = useWorkbenchStore((state) => state.setThreadPanes);
  const saved = useWorkbenchStore((state) => state.layouts[LAYOUT_KEY]);
  const save = useWorkbenchStore((state) => state.saveLayout);
  const [choosing, setChoosing] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const openWindow = (thread: RememberedThread) => {
    setWindowError(null);
    void openThreadWindow(thread).catch((error: unknown) =>
      setWindowError(error instanceof Error ? error.message : "Could not open the session window."),
    );
  };
  const grid = useRef<HTMLDivElement>(null);
  const resize = useRef<{
    layout: PaneLayout;
    x: number;
    width: number;
    first: string;
    second: string;
  } | null>(null);
  const sessions = shells.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.lineage.relationshipToParent !== "subagent",
  );
  const extras = panes.filter(
    (pane) =>
      sessions.some(
        (thread) => thread.environmentId === pane.environmentId && thread.id === pane.threadId,
      ) &&
      (!current || threadPaneKey(pane) !== threadPaneKey(current)),
  );
  const split = active && current !== null && extras.length > 0;
  const ids = ["primary", ...extras.map(threadPaneKey)];
  const layout = reconcileLayout(ids, saved);
  const currentTitle =
    sessions.find(
      (thread) => thread.id === current?.threadId && thread.environmentId === current.environmentId,
    )?.title || "Current session";
  const title = (pane: RememberedThread) =>
    sessions.find(
      (thread) => thread.id === pane.threadId && thread.environmentId === pane.environmentId,
    )?.title || "Session";
  const choices = sessions.filter((thread) => {
    const key = threadPaneKey({ environmentId: thread.environmentId, threadId: thread.id });
    return (
      key !== (current && threadPaneKey(current)) &&
      !panes.some((pane) => threadPaneKey(pane) === key)
    );
  });
  const commit = (next: PaneLayout) => save(LAYOUT_KEY, next);
  return (
    <div data-wb-thread-workspace="">
      {active && current && (
        <div data-wb-thread-toolbar="">
          <span>{split ? `${extras.length + 1} sessions` : "Threads"}</span>
          <button type="button" onClick={() => openWindow(current)}>
            Open in new window
          </button>
          <button
            type="button"
            disabled={panes.length >= MAX_THREAD_PANES - 1 || choices.length === 0}
            onClick={() => setChoosing(!choosing)}
            aria-expanded={choosing}
          >
            Open session beside
          </button>
          {choosing && (
            <select
              aria-label="Session to open beside"
              value=""
              onChange={(event) => {
                const thread = choices.find(
                  (candidate) =>
                    threadPaneKey({
                      environmentId: candidate.environmentId,
                      threadId: candidate.id,
                    }) === event.target.value,
                );
                if (thread)
                  setPanes([
                    ...panes,
                    { environmentId: thread.environmentId, threadId: thread.id },
                  ]);
                setChoosing(false);
              }}
            >
              <option value="">Choose a session</option>
              {choices.map((thread) => (
                <option
                  key={threadPaneKey({ environmentId: thread.environmentId, threadId: thread.id })}
                  value={threadPaneKey({
                    environmentId: thread.environmentId,
                    threadId: thread.id,
                  })}
                >
                  {thread.title || "Untitled session"}
                </option>
              ))}
            </select>
          )}
          {split && (
            <button
              type="button"
              onClick={() =>
                commit({
                  ...layout,
                  weights: Object.fromEntries(ids.map((id) => [id, 1 / ids.length])),
                })
              }
            >
              Equal widths
            </button>
          )}
          {panes.length > 0 && (
            <button type="button" onClick={() => setPanes([])}>
              Single session
            </button>
          )}
        </div>
      )}
      {active && windowError && <p role="alert">{windowError}</p>}
      <div
        ref={grid}
        data-wb-thread-grid=""
        data-split={split ? "true" : undefined}
        style={
          split
            ? {
                gridTemplateColumns: ids
                  .map((id) => `minmax(300px, ${layout.weights[id]}fr)`)
                  .join(" 6px "),
              }
            : undefined
        }
      >
        <section
          data-wb-thread-pane=""
          aria-label={currentTitle}
          style={split ? { gridColumn: 1, gridRow: 1 } : undefined}
        >
          {split && (
            <header data-wb-thread-pane-heading="">
              <span>{currentTitle}</span>
              <small>Sidebar selection</small>
            </header>
          )}
          <div data-wb-thread-pane-content="">{children}</div>
        </section>
        {extras.map((pane, index) => {
          const id = threadPaneKey(pane);
          const first = ids[index]!;
          return (
            <SessionSlot
              key={id}
              visible={split}
              pane={pane}
              title={title(pane)}
              column={index * 2 + 3}
              onClose={() => setPanes(panes.filter((other) => threadPaneKey(other) !== id))}
              onOpenWindow={() => openWindow(pane)}
              separator={
                <div
                  role="separator"
                  tabIndex={0}
                  aria-label={`Resize before ${title(pane)}`}
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(layout.weights[first]! * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  data-wb-thread-divider=""
                  style={{ gridColumn: index * 2 + 2, gridRow: 1 }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resize.current = {
                      layout,
                      x: event.clientX,
                      width: Math.max(1, grid.current?.scrollWidth ?? 1),
                      first,
                      second: id,
                    };
                  }}
                  onPointerMove={(event) => {
                    const drag = resize.current;
                    if (drag)
                      commit(
                        resizePanes(
                          drag.layout,
                          drag.first,
                          drag.second,
                          (event.clientX - drag.x) / drag.width,
                        ),
                      );
                  }}
                  onPointerUp={(event) => {
                    resize.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onLostPointerCapture={() => {
                    resize.current = null;
                  }}
                  onPointerCancel={() => {
                    resize.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    commit(
                      resizePanes(layout, first, id, event.key === "ArrowLeft" ? -0.05 : 0.05),
                    );
                  }}
                />
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function SessionSlot({
  visible,
  pane,
  title,
  column,
  onClose,
  onOpenWindow,
  separator,
}: {
  visible: boolean;
  pane: RememberedThread;
  title: string;
  column: number;
  onClose: () => void;
  onOpenWindow: () => void;
  separator: ReactNode;
}) {
  return (
    <>
      {visible && separator}
      <section
        data-wb-thread-pane=""
        hidden={!visible}
        inert={!visible}
        aria-label={title}
        style={{ gridColumn: column, gridRow: 1 }}
      >
        <header data-wb-thread-pane-heading="">
          <span>{title}</span>
          <button type="button" aria-label={`Open ${title} in new window`} onClick={onOpenWindow}>
            New window
          </button>
          <button type="button" aria-label={`Close pane for ${title}`} onClick={onClose}>
            Close pane
          </button>
        </header>
        <div data-wb-thread-pane-content="">
          <SessionPane thread={pane} />
        </div>
      </section>
    </>
  );
}
