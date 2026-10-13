import {
  PREVIEW_PAGE_AGENT_MESSAGE_TYPE,
  previewPageAgentCall,
  previewPageAgentScript,
  previewPlaywrightInstallScript,
} from "@t3tools/shared/previewPageAgent";
import { memo, useEffect, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View, type ViewInstance } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type {
  WebViewErrorEvent,
  WebViewNavigationEvent,
  WebViewNavigation,
} from "react-native-webview/lib/WebViewTypes";

import { reportBrowserTabStatus } from "./browserActions";
import {
  BrowserHostError,
  registerBrowserTabController,
  type BrowserReadiness,
  type BrowserTabController,
} from "./browserControllers";
import { browserStore, useBrowserState, type BrowserFrame, type BrowserTab } from "./browserStore";
import { PLAYWRIGHT_INJECTED_SOURCE } from "./playwrightInjectedSource.generated";

const DOM_READY_MESSAGE = "cw-dom-ready";
// Installed before the page's own scripts, so its console output is kept from the start.
const BEFORE_CONTENT_SCRIPT = `${previewPageAgentScript()}
document.addEventListener("DOMContentLoaded", function () {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: ${JSON.stringify(DOM_READY_MESSAGE)} }));
});
true;`;
const PLAYWRIGHT_INSTALL_SCRIPT = previewPlaywrightInstallScript(PLAYWRIGHT_INJECTED_SOURCE);
const BLANK_PAGE = "about:blank";

/**
 * Every browser tab's WebView, in one layer drawn above the app. The tab the Browser screen shows
 * sits over that screen's frame; the others stay mounted out of sight so agents can keep using them.
 */
export function BrowserWebViewLayer() {
  const tabs = useBrowserState((state) => state.tabs);
  const presented = useBrowserState((state) => state.presented);
  const layer = useRef<ViewInstance>(null);
  // The Browser screen measures its page area in window coordinates; the layer may not start at the
  // window's corner (a split view, an inset), so place tabs relative to where the layer is.
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const measureOrigin = () =>
    layer.current?.measureInWindow((x, y) => {
      if (x !== origin.x || y !== origin.y) setOrigin({ x, y });
    });
  const tabList = Object.values(tabs);
  if (tabList.length === 0) return null;
  return (
    <View
      ref={layer}
      collapsable={false}
      pointerEvents="box-none"
      style={StyleSheet.absoluteFill}
      onLayout={measureOrigin}
    >
      {tabList.map((tab) => (
        <BrowserTabWebView
          key={tab.key}
          tab={tab}
          frame={
            presented?.key === tab.key
              ? {
                  ...presented.frame,
                  x: presented.frame.x - origin.x,
                  y: presented.frame.y - origin.y,
                }
              : null
          }
        />
      ))}
    </View>
  );
}

const BrowserTabWebView = memo(function BrowserTabWebView(props: {
  readonly tab: BrowserTab;
  readonly frame: BrowserFrame | null;
}) {
  const { tab, frame } = props;
  const window = useWindowDimensions();
  const webView = useRef<WebView<object>>(null);
  const pending = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>(),
  );
  const loadWaiters = useRef<Array<{ readiness: BrowserReadiness; resolve: () => void }>>([]);
  const loading = useRef(tab.url !== null);
  const domReady = useRef(false);
  const playwrightInstalled = useRef(false);
  const nextId = useRef(0);
  const frameRef = useRef(frame);
  const windowRef = useRef(window);
  useEffect(() => {
    frameRef.current = frame;
    windowRef.current = window;
  });
  // The WebView loads what `source` says; a new object reloads even the same address.
  const [source, setSource] = useState(() => ({ uri: tab.url ?? BLANK_PAGE }));

  const settleWaiters = (reached: "domContentLoaded" | "load") => {
    loadWaiters.current = loadWaiters.current.filter((waiter) => {
      if (reached === "load" || waiter.readiness === "domContentLoaded") {
        waiter.resolve();
        return false;
      }
      return true;
    });
  };

  useEffect(() => {
    const controller: BrowserTabController = {
      run: (operation, input, timeoutMs) =>
        new Promise((resolve, reject) => {
          const id = `${tab.tabId}:${(nextId.current += 1)}`;
          const timer = setTimeout(() => {
            pending.current.delete(id);
            reject(
              new BrowserHostError(
                "PreviewAutomationTimeoutError",
                `The page did not answer ${operation} within ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
          pending.current.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          const needsEngine =
            !playwrightInstalled.current &&
            typeof input === "object" &&
            input !== null &&
            "locator" in input &&
            Boolean((input as { locator?: unknown }).locator);
          if (needsEngine) playwrightInstalled.current = true;
          webView.current?.injectJavaScript(
            `${needsEngine ? PLAYWRIGHT_INSTALL_SCRIPT : ""}${previewPageAgentCall(id, operation, input)}`,
          );
        }),
      load: (url) => {
        loading.current = true;
        domReady.current = false;
        setSource({ uri: url });
        browserStore.patchTab(tab.key, { url, loading: true });
      },
      waitForLoad: (readiness, timeoutMs) => {
        if (readiness === "none") return Promise.resolve();
        if (!loading.current || (readiness === "domContentLoaded" && domReady.current)) {
          return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            loadWaiters.current = loadWaiters.current.filter((waiter) => waiter !== entry);
            reject(
              new BrowserHostError(
                "PreviewAutomationTimeoutError",
                `The page did not finish loading within ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
          const entry = {
            readiness,
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
          };
          loadWaiters.current.push(entry);
        });
      },
      goBack: () => webView.current?.goBack(),
      goForward: () => webView.current?.goForward(),
      reload: () => webView.current?.reload(),
      stop: () => webView.current?.stopLoading(),
      viewport: () => {
        const current = frameRef.current;
        return current === null
          ? {
              width: Math.round(windowRef.current.width),
              height: Math.round(windowRef.current.height),
            }
          : { width: Math.round(current.width), height: Math.round(current.height) };
      },
    };
    const unregister = registerBrowserTabController(tab.key, controller);
    return () => {
      unregister();
      for (const entry of pending.current.values()) {
        entry.reject(
          new BrowserHostError("PreviewAutomationTabNotFoundError", "The tab was closed."),
        );
      }
      pending.current.clear();
    };
  }, [tab.key, tab.tabId]);

  const onMessage = (event: WebViewMessageEvent) => {
    let message: {
      type?: string;
      id?: string;
      ok?: boolean;
      value?: unknown;
      error?: { tag?: string; message?: string };
    };
    try {
      message = JSON.parse(event.nativeEvent.data) as typeof message;
    } catch {
      return;
    }
    if (message.type === DOM_READY_MESSAGE) {
      domReady.current = true;
      settleWaiters("domContentLoaded");
      return;
    }
    if (message.type !== PREVIEW_PAGE_AGENT_MESSAGE_TYPE || message.id === undefined) return;
    const entry = pending.current.get(message.id);
    if (!entry) return;
    pending.current.delete(message.id);
    if (message.ok) entry.resolve(message.value);
    else
      entry.reject(
        new BrowserHostError(
          message.error?.tag ?? "PreviewAutomationExecutionError",
          message.error?.message ?? "The page could not run the command.",
        ),
      );
  };

  const onNavigationStateChange = (navigation: WebViewNavigation) => {
    if (navigation.url === BLANK_PAGE && tab.url === null) return;
    browserStore.patchTab(tab.key, {
      url: navigation.url,
      title: navigation.title || navigation.url,
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward,
      loading: navigation.loading,
    });
  };
  const onLoadStart = (_event: WebViewNavigationEvent) => {
    loading.current = true;
    domReady.current = false;
    playwrightInstalled.current = false;
  };
  const onLoadEnd = (event: WebViewNavigationEvent | WebViewErrorEvent) => {
    loading.current = false;
    domReady.current = true;
    settleWaiters("load");
    const native = event.nativeEvent;
    const reached = native.url && native.url !== BLANK_PAGE ? native.url : null;
    browserStore.patchTab(tab.key, {
      loading: false,
      canGoBack: native.canGoBack,
      canGoForward: native.canGoForward,
      // Where the page ended up, after any redirect; navigation events can trail behind it.
      ...(reached === null ? {} : { url: reached, title: native.title || reached }),
    });
    if (native.url && native.url !== BLANK_PAGE) {
      reportBrowserTabStatus(browserStore.getState().tabs[tab.key] ?? tab, {
        url: native.url,
        title: native.title || native.url,
        failure:
          "code" in native
            ? { code: Number(native.code) || -1, description: String(native.description ?? "") }
            : null,
      });
    }
  };

  const style =
    frame === null
      ? // Out of sight, at phone size, so pages lay out as they would on screen.
        {
          position: "absolute" as const,
          left: -20_000,
          top: 0,
          width: window.width,
          height: window.height,
          opacity: 0,
        }
      : {
          position: "absolute" as const,
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
        };

  return (
    <View style={style} pointerEvents={frame === null ? "none" : "auto"}>
      <WebView
        ref={webView}
        source={source}
        originWhitelist={["*"]}
        injectedJavaScriptBeforeContentLoaded={BEFORE_CONTENT_SCRIPT}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        allowsInlineMediaPlayback
        setSupportMultipleWindows={false}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
        onLoadStart={onLoadStart}
        onLoadEnd={onLoadEnd}
        onContentProcessDidTerminate={() => webView.current?.reload()}
        onRenderProcessGone={() => webView.current?.reload()}
      />
    </View>
  );
});
