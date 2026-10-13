import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DevicePlatform, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { readStoredMiniPlayerPosition } from "./previewMiniPlayerPositionStorage";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

/** What the floating player mirrors: a browser tab or a device stream. */
export type PreviewMiniPlayerSource =
  | { readonly kind: "browser"; readonly tabId: string }
  | {
      readonly kind: "device";
      readonly hostId: string;
      readonly deviceId: string;
      readonly platform: DevicePlatform;
      readonly name: string;
    };

export interface PreviewMiniPlayerState {
  readonly source: PreviewMiniPlayerSource;
  readonly position: PreviewMiniPlayerPosition | null;
  /** Height always follows the mirrored source's aspect ratio. */
  readonly width: number | null;
  readonly lastInteraction: "drag" | "resize";
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  /** Threads whose person closed the floating preview; the agent may not bring it back. */
  readonly dismissedByThreadKey: Record<string, true>;
  /** A person's choice to show the preview. It also lifts a dismissal. */
  readonly open: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) => void;
  /** The agent using its browser. Does nothing, and says so, while the person has it dismissed. */
  readonly openForAgent: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) => boolean;
  readonly close: (ref: ScopedThreadRef) => void;
  /** The person's Close Preview: hides it and keeps the agent from re-showing it. */
  readonly dismiss: (ref: ScopedThreadRef) => void;
  /** Back to the default corner; the width stays. */
  readonly resetPosition: (ref: ScopedThreadRef, sourceKey: string) => void;
  /** `sourceKey` guards against a drag that outlives the source it started on. */
  readonly move: (
    ref: ScopedThreadRef,
    sourceKey: string,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (
    ref: ScopedThreadRef,
    sourceKey: string,
    width: number,
    position?: PreviewMiniPlayerPosition,
  ) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function previewMiniPlayerSourceKey(source: PreviewMiniPlayerSource): string {
  return source.kind === "browser"
    ? `browser:${source.tabId}`
    : `device:${encodeURIComponent(source.hostId)}:${encodeURIComponent(source.deviceId)}`;
}

export const browserMiniPlayerSource = (tabId: string): PreviewMiniPlayerSource => ({
  kind: "browser",
  tabId,
});

const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set, get) => {
  const show = (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      const dismissedByThreadKey = withoutKey(state.dismissedByThreadKey, threadKey);
      if (
        current &&
        previewMiniPlayerSourceKey(current.source) === previewMiniPlayerSourceKey(source)
      ) {
        return dismissedByThreadKey === state.dismissedByThreadKey
          ? state
          : { dismissedByThreadKey };
      }
      return {
        dismissedByThreadKey,
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            source,
            // A new conversation starts where this client last left the preview.
            position: current ? current.position : readStoredMiniPlayerPosition(),
            width: current?.width ?? null,
            lastInteraction: current?.lastInteraction ?? "drag",
          },
        },
      };
    });
  return {
    byThreadKey: {},
    dismissedByThreadKey: {},
    open: show,
    openForAgent: (ref, source) => {
      if (scopedThreadKey(ref) in get().dismissedByThreadKey) return false;
      show(ref, source);
      return true;
    },
    close: (ref) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        const byThreadKey = withoutKey(state.byThreadKey, threadKey);
        return byThreadKey === state.byThreadKey ? state : { byThreadKey };
      }),
    dismiss: (ref) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        return {
          byThreadKey: withoutKey(state.byThreadKey, threadKey),
          dismissedByThreadKey: { ...state.dismissedByThreadKey, [threadKey]: true },
        };
      }),
    resetPosition: (ref, sourceKey) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        const current = state.byThreadKey[threadKey];
        if (!current || previewMiniPlayerSourceKey(current.source) !== sourceKey) return state;
        return {
          byThreadKey: {
            ...state.byThreadKey,
            [threadKey]: { ...current, position: null, lastInteraction: "drag" },
          },
        };
      }),
    move: (ref, sourceKey, position) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        const current = state.byThreadKey[threadKey];
        if (!current || previewMiniPlayerSourceKey(current.source) !== sourceKey) return state;
        if (
          current.position?.x === position.x &&
          current.position.y === position.y &&
          current.lastInteraction === "drag"
        )
          return state;
        return {
          byThreadKey: {
            ...state.byThreadKey,
            [threadKey]: { ...current, position, lastInteraction: "drag" },
          },
        };
      }),
    resize: (ref, sourceKey, width, position) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        const current = state.byThreadKey[threadKey];
        if (
          !current ||
          previewMiniPlayerSourceKey(current.source) !== sourceKey ||
          (current.width === width &&
            current.lastInteraction === "resize" &&
            (!position ||
              (current.position?.x === position.x && current.position.y === position.y)))
        ) {
          return state;
        }
        return {
          byThreadKey: {
            ...state.byThreadKey,
            [threadKey]: {
              ...current,
              width,
              position: position ?? current.position,
              lastInteraction: "resize",
            },
          },
        };
      }),
    removeThread: (ref) =>
      set((state) => {
        const threadKey = scopedThreadKey(ref);
        const byThreadKey = withoutKey(state.byThreadKey, threadKey);
        const dismissedByThreadKey = withoutKey(state.dismissedByThreadKey, threadKey);
        return byThreadKey === state.byThreadKey &&
          dismissedByThreadKey === state.dismissedByThreadKey
          ? state
          : { byThreadKey, dismissedByThreadKey };
      }),
  };
});

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

/** Whether the person closed this thread's floating preview and has not brought it back. */
export function selectThreadPreviewMiniPlayerDismissed(
  dismissedByThreadKey: Record<string, true>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref ? scopedThreadKey(ref) in dismissedByThreadKey : false;
}

/** The floating browser tab, or null when nothing floats or a device does. */
export function selectThreadPreviewMiniPlayerTabId(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  const source = selectThreadPreviewMiniPlayer(byThreadKey, ref)?.source;
  return source?.kind === "browser" ? source.tabId : null;
}
