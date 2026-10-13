import { useState } from "react";
import {
  type CodeTask,
  MAX_TASK_TEXT,
  MAX_TASKS,
  type TaskColumn,
  taskColumnLabels,
  taskColumns,
} from "./codeTasks";

/**
 * A workspace's task board. A card handed to a pane is typed into that pane's CLI
 * and comes back to Review on its own when the pane's turn ends.
 */
export function CodeTasksBoard({
  tasks,
  panes,
  paneLabel,
  onAdd,
  onHand,
  onMove,
  onDelete,
}: {
  tasks: ReadonlyArray<CodeTask>;
  /** Panes that can take a task right now. */
  panes: ReadonlyArray<{ id: string; label: string }>;
  paneLabel: (paneId: string) => string | undefined;
  onAdd: (text: string) => void;
  onHand: (id: string, paneId: string) => void;
  onMove: (id: string, column: TaskColumn) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <aside data-wb-code-tasks="" aria-label="Workspace Tasks">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || tasks.length >= MAX_TASKS) return;
          onAdd(draft.trim());
          setDraft("");
        }}
      >
        <input
          aria-label="New Task"
          placeholder="Add a task"
          maxLength={MAX_TASK_TEXT}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={!draft.trim() || tasks.length >= MAX_TASKS}>
          Add
        </button>
      </form>
      {taskColumns.map((column) => {
        const cards = tasks.filter((task) => task.column === column);
        return (
          <section key={column} data-column={column} aria-label={taskColumnLabels[column]}>
            <h3>
              {taskColumnLabels[column]} <small>{cards.length}</small>
            </h3>
            {cards.map((task) => (
              <article key={task.id}>
                <p>{task.text}</p>
                {task.paneId && <small>With {paneLabel(task.paneId) ?? "a closed pane"}</small>}
                <div>
                  {column !== "doing" && column !== "done" && (
                    <select
                      aria-label={`Hand ${task.text} To A Pane`}
                      value=""
                      disabled={panes.length === 0}
                      onChange={(event) =>
                        event.target.value && onHand(task.id, event.target.value)
                      }
                    >
                      <option value="">{panes.length ? "Hand To" : "No Pane Ready"}</option>
                      {panes.map((pane) => (
                        <option key={pane.id} value={pane.id}>
                          {pane.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    aria-label={`Move ${task.text}`}
                    value={column}
                    onChange={(event) => {
                      const next = taskColumns.find((item) => item === event.target.value);
                      if (next && next !== column) onMove(task.id, next);
                    }}
                  >
                    {taskColumns.map((item) => (
                      <option key={item} value={item}>
                        {taskColumnLabels[item]}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => onDelete(task.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </aside>
  );
}
