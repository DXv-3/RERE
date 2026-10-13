import type { PaneActivity } from "./workspaceLayout";

export const taskColumns = ["todo", "doing", "review", "done"] as const;
export type TaskColumn = (typeof taskColumns)[number];
export const taskColumnLabels: Record<TaskColumn, string> = {
  todo: "To Do",
  doing: "In Progress",
  review: "Review",
  done: "Done",
};
/** A card on a workspace's board. Kept with the workspace on this device. */
export interface CodeTask {
  id: string;
  text: string;
  column: TaskColumn;
  /** The pane working on it, while it is in progress. */
  paneId?: string;
  /** Set once that pane has been seen busy, so a pane that is still idle is not read as finished. */
  started?: boolean;
}

export const MAX_TASKS = 60;
export const MAX_TASK_TEXT = 2_000;

/** The task as one line to type into a CLI; control characters would act as keystrokes. */
export function taskLine(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** Gives a card to a pane and puts it in progress. */
export function handTask(
  tasks: ReadonlyArray<CodeTask>,
  id: string,
  paneId: string,
): ReadonlyArray<CodeTask> {
  return tasks.map((task) =>
    task.id === id ? { id, text: task.text, column: "doing", paneId } : task,
  );
}

/** Moves a card by hand. Leaving In Progress lets go of its pane. */
export function moveTask(
  tasks: ReadonlyArray<CodeTask>,
  id: string,
  column: TaskColumn,
): ReadonlyArray<CodeTask> {
  return tasks.map((task) => (task.id === id ? { id, text: task.text, column } : task));
}

/**
 * Moves handed cards to Review when their pane finishes its turn. Returns the same
 * array when nothing changed. A pane that closed or dropped to its shell leaves the
 * card where it is; Done is always the user's call.
 */
export function advanceTasks(
  tasks: ReadonlyArray<CodeTask>,
  activityOf: (paneId: string) => PaneActivity | undefined,
): ReadonlyArray<CodeTask> {
  let changed = false;
  const next = tasks.map((task) => {
    if (task.column !== "doing" || !task.paneId) return task;
    const activity = activityOf(task.paneId);
    const busy = activity === "working" || activity === "needs-you" || activity === "running";
    if (!task.started && busy) {
      changed = true;
      return { ...task, started: true };
    }
    if (task.started && activity === "idle") {
      changed = true;
      return { id: task.id, text: task.text, column: "review" as const };
    }
    return task;
  });
  return changed ? next : tasks;
}

export function readTasks(value: unknown): CodeTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (task): task is CodeTask =>
        typeof task?.id === "string" &&
        typeof task.text === "string" &&
        task.text.length <= MAX_TASK_TEXT &&
        taskColumns.includes(task.column),
    )
    .map(({ id, text, column, paneId, started }) => ({
      id,
      text,
      column,
      ...(column === "doing" && typeof paneId === "string" ? { paneId } : {}),
      ...(column === "doing" && started === true ? { started } : {}),
    }))
    .slice(0, MAX_TASKS);
}
