import type { EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/**
 * The phone's browser tabs. Each is a server preview session (so agents and other clients see
 * it) rendered in a WebView the phone owns. The WebViews live in one layer above the navigator so
 * a tab keeps its page while the person moves around the app; the Browser screen only says where
 * on screen the tab it shows should appear.
 */
export interface BrowserTab {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
  /** The address the WebView was last asked to load; null for a blank tab. */
  readonly url: string | null;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly openedAt: number;
}

export interface BrowserFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserState {
  readonly tabs: Readonly<Record<string, BrowserTab>>;
  /** The tab the Browser screen shows and where; null when no Browser screen is showing. */
  readonly presented: { readonly key: string; readonly frame: BrowserFrame } | null;
  /** The tab each thread last used, which is the one agents act on when they name none. */
  readonly currentByThread: Readonly<Record<string, string>>;
}

let state: BrowserState = { tabs: {}, presented: null, currentByThread: {} };
const listeners = new Set<() => void>();

function update(next: BrowserState) {
  state = next;
  for (const listener of listeners) listener();
}

export const browserThreadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;
export const browserTabKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
) => `${browserThreadKey(environmentId, threadId)}\u0000${tabId}`;

export const browserStore = {
  getState: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  upsertTab: (
    tab: Omit<BrowserTab, "key" | "openedAt"> & { readonly openedAt?: number },
  ): BrowserTab => {
    const key = browserTabKey(tab.environmentId, tab.threadId, tab.tabId);
    const previous = state.tabs[key];
    const next: BrowserTab = {
      ...tab,
      key,
      openedAt: previous?.openedAt ?? tab.openedAt ?? Date.now(),
    };
    update({
      ...state,
      tabs: { ...state.tabs, [key]: next },
      currentByThread: {
        ...state.currentByThread,
        [browserThreadKey(tab.environmentId, tab.threadId)]: key,
      },
    });
    return next;
  },
  patchTab: (key: string, patch: Partial<Omit<BrowserTab, "key">>) => {
    const previous = state.tabs[key];
    if (!previous) return;
    update({ ...state, tabs: { ...state.tabs, [key]: { ...previous, ...patch } } });
  },
  removeTab: (key: string) => {
    const tab = state.tabs[key];
    if (!tab) return;
    const { [key]: _removed, ...tabs } = state.tabs;
    const threadKey = browserThreadKey(tab.environmentId, tab.threadId);
    const remaining = Object.values(tabs)
      .filter(
        (candidate) => browserThreadKey(candidate.environmentId, candidate.threadId) === threadKey,
      )
      .sort((a, b) => b.openedAt - a.openedAt);
    const { [threadKey]: _current, ...currentByThread } = state.currentByThread;
    update({
      tabs,
      presented: state.presented?.key === key ? null : state.presented,
      currentByThread:
        remaining[0] === undefined
          ? currentByThread
          : { ...currentByThread, [threadKey]: remaining[0].key },
    });
  },
  setCurrent: (key: string) => {
    const tab = state.tabs[key];
    if (!tab) return;
    update({
      ...state,
      currentByThread: {
        ...state.currentByThread,
        [browserThreadKey(tab.environmentId, tab.threadId)]: key,
      },
    });
  },
  setPresented: (presented: BrowserState["presented"]) => {
    const current = state.presented;
    if (
      current === presented ||
      (current !== null &&
        presented !== null &&
        current.key === presented.key &&
        current.frame.x === presented.frame.x &&
        current.frame.y === presented.frame.y &&
        current.frame.width === presented.frame.width &&
        current.frame.height === presented.frame.height)
    ) {
      return;
    }
    update({ ...state, presented });
  },
};

export function currentBrowserTab(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): BrowserTab | undefined {
  const key = state.currentByThread[browserThreadKey(environmentId, threadId)];
  return key === undefined ? undefined : state.tabs[key];
}

const getState = () => state;

/**
 * A value from the browser state. React reads the whole state, which only changes on an update, so
 * the selector may derive a fresh value each render without looping; keep it cheap.
 */
export function useBrowserState<T>(select: (state: BrowserState) => T): T {
  return select(useSyncExternalStore(browserStore.subscribe, getState, getState));
}
