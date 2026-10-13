import { expect, it } from "vite-plus/test";
import { advanceTasks, handTask, moveTask, readTasks, taskLine } from "./codeTasks";

const todo = { id: "a", text: "Fix login", column: "todo" } as const;

it("puts a handed card in progress and sends it to review after its pane's turn", () => {
  const handed = handTask([todo], "a", "pane-1");
  expect(handed).toEqual([{ id: "a", text: "Fix login", column: "doing", paneId: "pane-1" }]);
  // The pane has not picked the task up yet; idle here is not "finished".
  expect(advanceTasks(handed, () => "idle")).toBe(handed);
  const started = advanceTasks(handed, () => "working");
  expect(started[0]).toMatchObject({ column: "doing", started: true });
  expect(advanceTasks(started, () => "needs-you")).toBe(started);
  expect(advanceTasks(started, () => "idle")).toEqual([
    { id: "a", text: "Fix login", column: "review" },
  ]);
});

it("leaves a card in progress when its pane closed or fell back to its shell", () => {
  const started = advanceTasks(handTask([todo], "a", "pane-1"), () => "running");
  expect(advanceTasks(started, () => undefined)).toBe(started);
  expect(advanceTasks(started, () => "shell")).toBe(started);
});

it("lets go of the pane when a card is moved by hand", () => {
  expect(moveTask(handTask([todo], "a", "pane-1"), "a", "done")).toEqual([
    { id: "a", text: "Fix login", column: "done" },
  ]);
});

it("types a task as one line with no control characters", () => {
  expect(taskLine(" Fix login\nthen\u0003test ")).toBe("Fix login then test");
});

it("keeps only well-formed saved cards", () => {
  expect(
    readTasks([
      { ...todo, paneId: "stale" },
      { id: "b", text: "x", column: "nowhere" },
      { id: "c", text: "Ship", column: "doing", paneId: "pane-2", started: true },
      null,
    ]),
  ).toEqual([todo, { id: "c", text: "Ship", column: "doing", paneId: "pane-2", started: true }]);
});
