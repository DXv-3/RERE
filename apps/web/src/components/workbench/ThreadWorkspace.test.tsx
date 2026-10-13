// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerHandleContext } from "../../composerHandleContext";
import { ThreadWorkspace } from "./ThreadWorkspace";
import { readThreadPanes, threadPaneKey, useWorkbenchStore } from "./workbenchStore";
const data = vi.hoisted(() => ({
  pathname: "/env/one",
  mounted: vi.fn(),
  shells: ["one", "two", "three"].map((id) => ({
    id,
    environmentId: "env",
    title: `Session ${id}`,
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null },
  })),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (v: { pathname: string }) => unknown }) =>
    select({ pathname: data.pathname }),
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => data.shells }));
vi.mock("../ChatView", () => ({
  default: ({ threadId }: { threadId: string }) => <Draft id={threadId} />,
}));
function Draft({ id }: { id: string }) {
  const [value, setValue] = useState("");
  const ref = useComposerHandleContext();
  useEffect(() => {
    data.mounted(id, ref);
  }, [id, ref]);
  return (
    <input aria-label={`Draft ${id}`} value={value} onChange={(e) => setValue(e.target.value)} />
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  data.pathname = "/env/one";
  data.mounted.mockClear();
  useWorkbenchStore.setState({ threadPanes: [], layouts: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (active = true) =>
  act(async () =>
    root.render(
      <ThreadWorkspace active={active}>
        <Draft id="primary" />
      </ThreadWorkspace>,
    ),
  );
async function click(text: string) {
  const b = [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;
  await act(async () => b.click());
}
async function add(id: string) {
  await click("Open session beside");
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = threadPaneKey({ environmentId: "env", threadId: id });
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="Draft ${id}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("keeps independent drafts and handles through resize, mode changes and closing another pane", async () => {
  await render();
  await type("primary", "Main draft");
  await add("two");
  await type("two", "Second draft");
  await add("three");
  const handles = data.mounted.mock.calls.filter(([id]) => id !== "primary").map(([, ref]) => ref);
  expect(handles).toHaveLength(2);
  expect(handles[0]).not.toBe(handles[1]);
  await act(async () => {
    container
      .querySelector('[role="separator"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  await render(false);
  expect(container.querySelector('[aria-label="Session two"]')?.hasAttribute("hidden")).toBe(true);
  await render(true);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Close pane for Session three"]')!
      .click(),
  );
  expect(container.querySelector<HTMLInputElement>('[aria-label="Draft primary"]')?.value).toBe(
    "Main draft",
  );
  expect(container.querySelector<HTMLInputElement>('[aria-label="Draft two"]')?.value).toBe(
    "Second draft",
  );
  expect(data.mounted.mock.calls.map(([id]) => id)).toEqual(["primary", "two", "three"]);
  await click("Single session");
  expect(container.querySelector('[aria-label="Draft two"]')).toBeNull();
  expect(useWorkbenchStore.getState().threadPanes).toEqual([]);
});
it("restores panes without duplicating the session selected in the sidebar", async () => {
  await render();
  await add("two");
  const storage = useWorkbenchStore.persist.getOptions().storage!;
  const saved = await storage.getItem("workbench:presentation:v1");
  await act(async () => useWorkbenchStore.setState({ threadPanes: [] }));
  await storage.setItem("workbench:presentation:v1", saved!);
  await act(async () => useWorkbenchStore.persist.rehydrate());
  expect(container.querySelector('[aria-label="Draft two"]')).not.toBeNull();
  data.pathname = "/env/two";
  await render();
  expect(container.querySelector('[aria-label="Draft two"]')).toBeNull();
  expect(container.querySelector('[role="separator"]')).toBeNull();
});
it("validates saved panes, removes duplicates and limits sessions", () => {
  expect(
    readThreadPanes([null, { threadId: "bad" }, { environmentId: "", threadId: "bad" }]),
  ).toEqual([]);
  expect(
    readThreadPanes(
      ["one", "one", "two", "three", "four"].map((threadId) => ({
        environmentId: "env",
        threadId,
      })),
    ).map((p) => p.threadId),
  ).toEqual(["one", "two", "three"]);
});
