import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CodeBroadcastBar, CodeLayoutsMenu } from "./CodeWorkspaceControls";

let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
const panes = [
  { id: "a", kind: "claude" as const, label: "Planner" },
  { id: "b", kind: "codex" as const, label: "Builder" },
];

it("broadcast asks before sending, skips a pane waiting on a question, then clears", async () => {
  const send = vi.fn();
  const third = { id: "c", kind: "shell" as const, label: "Asking" };
  await act(async () => {
    renderer = create(
      <CodeBroadcastBar panes={[...panes, third]} waiting={new Set(["c"])} onSend={send} />,
    );
  });
  const boxes = () => renderer.root.findAllByProps({ type: "checkbox" });
  const text = () => renderer.root.findByProps({ "aria-label": "Text To Send" });
  const submit = () =>
    renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
  expect(boxes().map((box) => box.props.checked)).toEqual([false, false, false]);
  expect(boxes()[2]!.props.disabled).toBe(true);
  await act(async () => text().props.onChange({ target: { value: "run the tests" } }));
  await act(async () => submit());
  expect(send).not.toHaveBeenCalled();
  await act(async () => boxes()[1]!.props.onChange({ target: { checked: true } }));
  await act(async () => submit());
  // The first press only names who will receive it.
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("Builder");
  await act(async () => submit());
  expect(send).toHaveBeenCalledWith(["b"], "run the tests");
  expect(boxes().map((box) => box.props.checked)).toEqual([false, false, false]);
  expect(text().props.value).toBe("");
});

it("a layout cannot be opened over running terminals", async () => {
  const open = vi.fn();
  await act(async () => {
    renderer = create(
      <CodeLayoutsMenu
        saved={[]}
        canSave
        canOpen={false}
        onSave={() => {}}
        onDelete={() => {}}
        onOpen={open}
      />,
    );
  });
  const openButton = renderer.root
    .findAllByType("button")
    .find((button) => button.props.children === "Open");
  expect(openButton?.props.disabled).toBe(true);
});
