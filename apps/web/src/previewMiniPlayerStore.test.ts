import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  type PreviewMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  selectThreadPreviewMiniPlayerDismissed,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const tabA = browserMiniPlayerSource("tab-a");
const tabB = browserMiniPlayerSource("tab-b");
const pixel: PreviewMiniPlayerSource = {
  kind: "device",
  hostId: "nucbox",
  deviceId: "emulator-5580",
  platform: "android",
  name: "Pixel",
};

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {}, dismissedByThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("keeps floating previews scoped to their thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refB, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ source: tabA });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ source: tabB });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().open(refA, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: { x: 24, y: 48 },
      width: null,
      lastInteraction: "drag",
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: null,
      width: null,
      lastInteraction: "drag",
    });
  });

  it("preserves a thread-bound width while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().resize(refA, "browser:tab-a", 480);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ source: tabB, width: 480 });
  });

  it("keeps a resize placement after release and clears it when dragging", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, tabA);
    store.resize(refA, "browser:tab-a", 460, { x: 1112, y: 275 });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ width: 460, position: { x: 1112, y: 275 }, lastInteraction: "resize" });
    store.move(refA, "browser:tab-a", { x: 1112, y: 275 });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ width: 460, position: { x: 1112, y: 275 }, lastInteraction: "drag" });
  });

  it("floats one source per thread, so a device replaces the browser tab", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, pixel);
    const floating = selectThreadPreviewMiniPlayer(
      usePreviewMiniPlayerStore.getState().byThreadKey,
      refA,
    );

    expect(floating).toMatchObject({ source: pixel });
    expect(
      selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBeNull();
    // The same device under a new label is still the same floating source.
    usePreviewMiniPlayerStore.getState().open(refA, { ...pixel, name: "Renamed" });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBe(floating);
  });
  describe("closing the floating preview", () => {
    const state = () => usePreviewMiniPlayerStore.getState();
    const player = (ref = refA) => selectThreadPreviewMiniPlayer(state().byThreadKey, ref);
    const dismissed = (ref = refA) =>
      selectThreadPreviewMiniPlayerDismissed(state().dismissedByThreadKey, ref);

    it("hides the preview and keeps the agent from bringing it back", () => {
      state().open(refA, tabA);
      state().dismiss(refA);

      expect(player()).toBeNull();
      expect(dismissed()).toBe(true);
      expect(state().openForAgent(refA, tabA)).toBe(false);
      expect(player()).toBeNull();
    });

    it("lets the agent show the preview while nobody closed it", () => {
      expect(state().openForAgent(refA, tabA)).toBe(true);
      expect(player()).toMatchObject({ source: tabA });
    });

    it("keeps the dismissal to one conversation", () => {
      state().dismiss(refA);

      expect(dismissed(refB)).toBe(false);
      expect(state().openForAgent(refB, tabB)).toBe(true);
    });

    it("shows the preview again when a person opens it", () => {
      state().dismiss(refA);
      state().open(refA, tabA);

      expect(player()).toMatchObject({ source: tabA });
      expect(dismissed()).toBe(false);
      expect(state().openForAgent(refA, tabB)).toBe(true);
    });

    it("does not count an internal close as a dismissal", () => {
      state().open(refA, tabA);
      state().close(refA);

      expect(dismissed()).toBe(false);
      expect(state().openForAgent(refA, tabA)).toBe(true);
    });

    it("forgets the dismissal with the thread", () => {
      state().dismiss(refA);
      state().removeThread(refA);

      expect(dismissed()).toBe(false);
    });
  });

  it("returns to the default corner and keeps the width", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().resize(refA, "browser:tab-a", 480, { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 120 });
    usePreviewMiniPlayerStore.getState().resetPosition(refA, "browser:tab-a");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({ source: tabA, position: null, width: 480, lastInteraction: "drag" });
  });

  it("ignores a reset aimed at a source that is no longer floating", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 120 });
    usePreviewMiniPlayerStore.getState().resetPosition(refA, "browser:tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)
        ?.position,
    ).toEqual({ x: 100, y: 120 });
  });
});
