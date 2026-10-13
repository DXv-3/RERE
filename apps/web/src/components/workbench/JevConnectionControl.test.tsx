import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import * as Redacted from "effect/Redacted";
import { EnvironmentId } from "@t3tools/contracts";
import { JevConnectionControl } from "./JevConnectionControl";

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { routingConfigure: "configure" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => configure }));
vi.mock("../ui/input", () => ({ Input: "input" }));
let renderer: ReactTestRenderer;
const changed = vi.fn();
const render = async (configured: boolean) => {
  await act(async () => {
    renderer = create(
      <JevConnectionControl
        environmentId={EnvironmentId.make("test")}
        configured={configured}
        onChanged={changed}
      />,
    );
  });
};
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("clears the entered key immediately, wraps it as redacted, and suppresses duplicate submissions", async () => {
  let resolve!: (v: { _tag: "Success"; value: { configured: boolean } }) => void;
  configure.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await render(false);
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ target: { value: "test-private-key" } }),
  );
  const submit = () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
  await act(async () => {
    submit();
    submit();
  });
  expect(configure).toHaveBeenCalledTimes(1);
  expect(Redacted.value(configure.mock.calls[0]![0].input.key)).toBe("test-private-key");
  expect(JSON.stringify(configure.mock.calls[0]![0])).not.toContain("test-private-key");
  expect(renderer.root.findByType("input").props.value).toBe("");
  await act(async () => resolve({ _tag: "Success", value: { configured: true } }));
  expect(changed).toHaveBeenCalledTimes(1);
});
it("disconnects explicitly and reports an uncertain save without retrying", async () => {
  configure.mockRejectedValue(new Error("lost connection"));
  await render(true);
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(configure.mock.calls[0]![0].input).toEqual({ action: "disconnect" });
  expect(JSON.stringify(renderer.toJSON())).toContain("Refresh Routing to check");
  expect(changed).not.toHaveBeenCalled();
  expect(configure).toHaveBeenCalledTimes(1);
});
