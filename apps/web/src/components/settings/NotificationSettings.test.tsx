import type { ClientSettings } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "sound" as ClientSettings["notificationMode"],
  permission: "default" as NotificationPermission,
  request: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: object) => unknown) =>
    select({ notificationMode: state.mode }),
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ description, control }: { description: ReactNode; control: ReactNode }) => (
    <>
      {description}
      {control}
    </>
  ),
  SettingResetButton: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: () => null,
  SelectItem: () => null,
}));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));

import { NotificationSettings } from "./NotificationSettings";

let renderer: ReactTestRenderer;
beforeEach(async () => {
  vi.clearAllMocks();
  state.mode = "sound";
  state.permission = "default";
  state.request.mockImplementation(async () => (state.permission = "granted"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { isSecureContext: true }));
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("Notification", {
    get permission() {
      return state.permission;
    },
    requestPermission: state.request,
  });
  await act(() => {
    renderer = create(<NotificationSettings />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
async function choose(value: string) {
  await act(async () => {
    await renderer.root.findAllByType("select")[0]!.props.onChange({ target: { value } });
  });
}
function description() {
  return JSON.stringify(renderer.toJSON());
}

it("explains Sound only without prompting or changing preferences on mount", () => {
  expect(description()).toContain("it does not send system banners");
  expect(description()).toContain("permission has not been granted");
  expect(state.request).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
});
it("requests permission when opting into banners and only then saves the mode", async () => {
  await choose("notifications");
  expect(state.request).toHaveBeenCalledOnce();
  expect(state.update).toHaveBeenCalledWith({ notificationMode: "notifications" });
  expect(description()).toContain("permission is granted");
});
it("keeps the preference when permission is denied and shows recovery instructions", async () => {
  state.request.mockImplementation(async () => (state.permission = "denied"));
  await choose("notifications-and-sound");
  expect(state.update).not.toHaveBeenCalled();
  expect(description()).toContain("System banners are blocked");
  expect(description()).toContain("System Settings");
  state.permission = "granted";
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(description()).toContain("permission is granted");
  await choose("notifications");
  expect(state.request).toHaveBeenCalledOnce();
  expect(state.update).toHaveBeenCalledWith({ notificationMode: "notifications" });
});
it.each(["sound", "off"])("does not request permission for %s", async (mode) => {
  await choose(mode);
  expect(state.request).not.toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledWith({ notificationMode: mode });
});
