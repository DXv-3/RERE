import { act, useEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WorkbenchTerminalLayout } from "./WorkbenchTerminalLayout";
import { WorkbenchContent } from "./WorkbenchShell";
import { useWorkbenchStore } from "./workbenchStore";

vi.mock("./AgentWorkspace", () => ({ AgentWorkspace: () => null }));
vi.mock("./ThreadWorkspace", () => ({
  ThreadWorkspace: ({ children }: { children: React.ReactNode }) => children,
}));

let renderer: ReactTestRenderer;
const mounted = vi.fn();
const unmounted = vi.fn();
function TerminalResource({ id }: { id: string }) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    mounted(id);
    return () => {
      unmounted(id);
    };
  }, [id]);
  return (
    <input aria-label={`Draft ${id}`} value={draft} onChange={(e) => setDraft(e.target.value)} />
  );
}
async function renderLayout() {
  await act(async () => {
    renderer = create(
      <WorkbenchContent>
        <WorkbenchTerminalLayout
          layoutKey="environment/thread/group"
          ids={["a", "b"]}
          direction="horizontal"
          label={(id) => id}
        >
          {(id) => <TerminalResource id={id} />}
        </WorkbenchTerminalLayout>
      </WorkbenchContent>,
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useWorkbenchStore.setState({ mode: "thread", layouts: {} });
  mounted.mockClear();
  unmounted.mockClear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("live pane presentation", () => {
  it("retains unsent input and mounted resources through moving, resizing, renaming, and modes", async () => {
    await renderLayout();
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Draft a" })
        .props.onChange({ target: { value: "npm test" } }),
    );
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Move a" })
        .props.onChange({ target: { value: "b" } }),
    );
    await act(async () =>
      renderer.root
        .findByProps({ role: "separator" })
        .props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() }),
    );
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Name For a" })
        .props.onChange({ target: { value: "Tests" } }),
    );
    for (const mode of ["code", "agent", "thread"] as const)
      await act(async () => useWorkbenchStore.getState().setMode(mode));
    expect(renderer.root.findByProps({ "aria-label": "Draft a" }).props.value).toBe("npm test");
    expect(mounted.mock.calls).toEqual([["a"], ["b"]]);
    expect(unmounted).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().layouts["environment/thread/group"]?.order).toEqual([
      "b",
      "a",
    ]);
    expect(useWorkbenchStore.getState().layouts["environment/thread/group"]?.labels.a).toBe(
      "Tests",
    );
  });
  it("round-trips layout preferences through storage without applying them to a different thread", async () => {
    await renderLayout();
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Move a" })
        .props.onChange({ target: { value: "b" } }),
    );
    const storage = useWorkbenchStore.persist.getOptions().storage!;
    const saved = await storage.getItem("workbench:presentation:v1");
    await act(async () => useWorkbenchStore.setState({ layouts: {} }));
    await storage.setItem("workbench:presentation:v1", saved!);
    await act(async () => useWorkbenchStore.persist.rehydrate());
    expect(useWorkbenchStore.getState().layouts["environment/thread/group"]?.order).toEqual([
      "b",
      "a",
    ]);
    expect(useWorkbenchStore.getState().layouts["other-environment/thread/group"]).toBeUndefined();
  });
});
