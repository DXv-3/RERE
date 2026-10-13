import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSummaryAtoms } from "@t3tools/client-runtime/state/presentation";
import {
  type EnvironmentId,
  PREVIEW_AUTOMATION_MOBILE_OPERATIONS,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  type PreviewAutomationStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { previewEnvironment } from "../../state/preview";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { navigateBrowserTab, openBrowserTab, resolveBrowserTarget } from "./browserActions";
import { browserStore, browserTabKey, currentBrowserTab, type BrowserTab } from "./browserStore";
import { BrowserHostError, browserTabController } from "./browserControllers";

const { connectedEnvironmentIdsAtom } = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

/** Leaves time to answer before the server gives up on this host and drops it. */
const hostBudgetMs = (timeoutMs: number) =>
  Math.max(1_000, timeoutMs - Math.min(1_500, Math.ceil(timeoutMs * 0.2)));

/**
 * Lets agents drive a browser on this phone. While the app runs it registers with each connected
 * CodeWrench server as a browser host for the operations a WebView can do (no screenshots,
 * resizing or recording). Requests run in the phone's own WebViews, so the person sees the page in
 * the thread's Browser screen.
 */
export function BrowserAutomationHosts() {
  const environmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  return (
    <>
      {environmentIds.map((environmentId) => (
        <BrowserAutomationHost key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function BrowserAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const [clientId] = useState(() => `mobile-${uuidv4()}`);
  const connectionId = useRef<string | null>(null);
  const requestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: {
      clientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_MOBILE_OPERATIONS],
    },
  });

  useEffect(() => {
    const respond = (response: PreviewAutomationResponse) =>
      runAtomCommand(
        appAtomRegistry,
        previewEnvironment.respondToAutomation,
        { environmentId, input: response },
        { reportFailure: false, reportDefect: false },
      );
    const reportFocus = () => {
      if (connectionId.current === null) return;
      const state = browserStore.getState();
      const liveTabs = Object.values(state.tabs)
        .filter((tab) => tab.environmentId === environmentId)
        .map((tab) => ({
          threadId: tab.threadId,
          tabId: tab.tabId,
          visible: state.presented?.key === tab.key,
        }));
      void runAtomCommand(
        appAtomRegistry,
        previewEnvironment.focusAutomationHost,
        {
          environmentId,
          input: {
            clientId,
            environmentId,
            connectionId: connectionId.current as never,
            focused: AppState.currentState === "active",
            liveTabs,
          },
        },
        { reportFailure: false, reportDefect: false },
      );
    };
    const unsubscribe = appAtomRegistry.subscribe(
      requestsAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const event = result.value;
        if (connectionId.current !== event.connectionId) {
          connectionId.current = event.connectionId;
          reportFocus();
        }
        if (event.type !== "request") return;
        const request = event.request;
        handleRequest(environmentId, request).then(
          (value) =>
            respond({
              clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: true,
              ...(value === undefined ? {} : { result: value }),
            }),
          (error: unknown) =>
            respond({
              clientId,
              connectionId: event.connectionId,
              requestId: request.requestId,
              ok: false,
              error: {
                _tag:
                  error instanceof BrowserHostError || (error as { cwTag?: string })?.cwTag
                    ? ((error as { cwTag: string }).cwTag ?? "PreviewAutomationExecutionError")
                    : "PreviewAutomationExecutionError",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        );
      },
      { immediate: true },
    );
    const appState = AppState.addEventListener("change", reportFocus);
    const browser = browserStore.subscribe(reportFocus);
    return () => {
      unsubscribe();
      appState.remove();
      browser();
    };
  }, [clientId, environmentId, requestsAtom]);

  return null;
}

function statusOf(tab: BrowserTab | undefined): PreviewAutomationStatus {
  if (tab === undefined) {
    return { available: true, visible: false, tabId: null, url: null, title: null, loading: false };
  }
  const presented = browserStore.getState().presented?.key === tab.key;
  return {
    available: true,
    visible: presented,
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
  };
}

async function handleRequest(
  environmentId: EnvironmentId,
  request: PreviewAutomationRequest,
): Promise<unknown> {
  const budget = hostBudgetMs(request.timeoutMs);
  const threadId = request.threadId as ThreadId;
  const named =
    request.tabId === undefined
      ? undefined
      : browserStore.getState().tabs[browserTabKey(environmentId, threadId, request.tabId)];
  const target = named ?? currentBrowserTab(environmentId, threadId);
  const requireTab = () => {
    if (target === undefined) {
      throw new BrowserHostError(
        "PreviewAutomationTabNotFoundError",
        request.tabId === undefined
          ? "This thread has no browser tab on the phone yet. Call preview_open first."
          : `Tab ${request.tabId} is not open on the phone.`,
      );
    }
    return target;
  };

  switch (request.operation) {
    case "status":
      return statusOf(target);
    case "open": {
      const input = request.input as PreviewAutomationOpenInput;
      const url =
        input.url === undefined
          ? undefined
          : resolveBrowserTarget(environmentId, { kind: "url", url: input.url });
      const reuse = input.reuseExistingTab ?? true;
      if (reuse && target !== undefined) {
        if (url !== undefined) await navigateBrowserTab(target, url);
        browserStore.setCurrent(target.key);
        return statusOf(browserStore.getState().tabs[target.key]);
      }
      const opened = await openBrowserTab({
        environmentId,
        threadId,
        ...(url === undefined ? {} : { url }),
      });
      return statusOf(opened);
    }
    case "navigate": {
      const tab = requireTab();
      const input = request.input as PreviewAutomationNavigateInput;
      const url = resolveBrowserTarget(
        environmentId,
        input.target ?? { kind: "url", url: input.url! },
      );
      await navigateBrowserTab(tab, url);
      const controller = await browserTabController(tab.key, budget);
      await controller.waitForLoad(
        input.readiness ?? "load",
        Math.min(input.timeoutMs ?? budget, budget),
      );
      return statusOf(browserStore.getState().tabs[tab.key]);
    }
    case "snapshot": {
      const tab = requireTab();
      const controller = await browserTabController(tab.key, budget);
      const page = (await controller.run("snapshot", {}, budget)) as Record<string, unknown>;
      // A WebView cannot capture its pixels or read network and accessibility data; the server
      // tells the agent the snapshot is text only.
      return {
        ...page,
        accessibilityTree: null,
        networkEntries: [],
        actionTimeline: [],
      };
    }
    case "click":
    case "type":
    case "press":
    case "scroll":
    case "waitFor": {
      const tab = requireTab();
      const controller = await browserTabController(tab.key, budget);
      const input = request.input as { timeoutMs?: number };
      await controller.run(
        request.operation,
        request.operation === "waitFor"
          ? { ...input, timeoutMs: Math.min(input.timeoutMs ?? budget, budget - 250) }
          : input,
        budget,
      );
      return {};
    }
    case "evaluate": {
      const tab = requireTab();
      const controller = await browserTabController(tab.key, budget);
      return await controller.run("evaluate", request.input, budget);
    }
    default:
      throw new BrowserHostError(
        "PreviewAutomationUnsupportedClientError",
        `The phone's browser cannot run ${request.operation}.`,
      );
  }
}
