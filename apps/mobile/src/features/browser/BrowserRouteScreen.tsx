import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, AppTextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { AppSymbolName } from "../../components/AppSymbol";
import {
  closeBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  resolveBrowserTarget,
} from "./browserActions";
import { browserStore, browserThreadKey, useBrowserState, type BrowserTab } from "./browserStore";
import { browserTabController } from "./browserControllers";

type BrowserRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * A thread's browser on the phone. The same tabs agents drive with their browser tools: what an
 * agent opens appears here, and what the person types here is what the agent will see.
 */
export function BrowserRouteScreen({ route }: BrowserRouteScreenProps) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threadKey = browserThreadKey(environmentId, threadId);
  // Select the store's own object and derive the list here: a selector that builds a new array
  // each time looks like a change on every read and re-renders forever.
  const allTabs = useBrowserState((state) => state.tabs);
  const tabs = Object.values(allTabs)
    .filter((tab) => browserThreadKey(tab.environmentId, tab.threadId) === threadKey)
    .sort((a, b) => a.openedAt - b.openedAt);
  const currentKey = useBrowserState((state) => state.currentByThread[threadKey] ?? null);
  const current = tabs.find((tab) => tab.key === currentKey) ?? tabs.at(-1);
  // What the person is typing; null shows the current page's address.
  const [draft, setDraft] = useState<string | null>(null);
  // The field shows the address without its scheme, so the host and path fit.
  const address = draft ?? current?.url?.replace(/^https?:\/\//i, "") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pageArea = useRef<ViewInstance>(null);

  // Place the current tab's WebView over the page area; take it away when this screen goes.
  const currentTabKey = current?.key ?? null;
  const placePage = () => {
    if (currentTabKey === null) {
      browserStore.setPresented(null);
      return;
    }
    pageArea.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) {
        browserStore.setPresented({ key: currentTabKey, frame: { x, y, width, height } });
      }
    });
  };
  // Re-place when the shown tab changes; layout changes call placePage themselves.
  useEffect(placePage, [currentTabKey]);
  useEffect(() => () => browserStore.setPresented(null), []);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const go = () => {
    Keyboard.dismiss();
    const text = address.trim();
    setDraft(null);
    if (text === "") return;
    void run(async () => {
      let url: string;
      try {
        url = resolveBrowserTarget(environmentId, {
          kind: "url",
          url: withCurrentScheme(text, current?.url ?? null),
        });
      } catch (cause) {
        if (cause instanceof TypeError)
          throw new Error(`"${text}" is not a web address.`, { cause });
        throw cause;
      }
      if (current === undefined) await openBrowserTab({ environmentId, threadId, url });
      else await navigateBrowserTab(current, url);
    });
  };
  const newTab = () => void run(() => openBrowserTab({ environmentId, threadId }));
  const control = (action: "goBack" | "goForward" | "reload" | "stop") => {
    if (current === undefined) return;
    void browserTabController(current.key, 2_000).then((controller) => controller[action]());
  };

  return (
    <View className="flex-1 bg-sheet" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-2 px-3 pb-2 pt-2">
        <IconButton label="Close browser" icon="xmark" onPress={() => navigation.goBack()} />
        <View className="flex-1 flex-row items-center rounded-full bg-subtle px-3">
          <SymbolView name="globe" size={15} tintColorClassName="accent-icon" type="monochrome" />
          <AppTextInput
            accessibilityLabel="Address"
            className="ml-2 h-10 flex-1 text-base"
            value={address}
            onChangeText={setDraft}
            onBlur={() => setDraft(null)}
            onSubmitEditing={go}
            placeholder="Enter an address, like localhost:5173"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
          />
          {current?.loading || busy ? <ActivityIndicator size="small" /> : null}
        </View>
        <IconButton label="New tab" icon="plus" onPress={newTab} />
      </View>
      {tabs.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="max-h-10 grow-0 px-3"
          contentContainerClassName="gap-2"
        >
          {tabs.map((tab) => (
            <TabChip
              key={tab.key}
              tab={tab}
              selected={tab.key === current?.key}
              onSelect={() => browserStore.setCurrent(tab.key)}
              onClose={() => void closeBrowserTab(tab)}
            />
          ))}
        </ScrollView>
      ) : null}
      {error ? (
        <AppText
          className="px-4 pb-2 text-sm text-danger-foreground"
          accessibilityLiveRegion="polite"
        >
          {error}
        </AppText>
      ) : null}
      <View
        ref={pageArea}
        collapsable={false}
        className="flex-1 border-t border-border-subtle bg-sheet"
        onLayout={(_event: LayoutChangeEvent) => placePage()}
      >
        {current === undefined ? (
          <View className="flex-1 items-center justify-center gap-2 px-8">
            <AppText className="text-center text-base font-medium">No pages open</AppText>
            <AppText className="text-center text-sm text-foreground-muted">
              Type an address above, or ask an agent in this thread to open one. Pages agents open
              appear here.
            </AppText>
          </View>
        ) : null}
      </View>
      <View
        className="flex-row items-center justify-around border-t border-border-subtle px-6 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 8) }}
      >
        <IconButton
          label="Back"
          icon="chevron.left"
          disabled={!current?.canGoBack}
          onPress={() => control("goBack")}
        />
        <IconButton
          label="Forward"
          icon="chevron.right"
          disabled={!current?.canGoForward}
          onPress={() => control("goForward")}
        />
        <IconButton
          label={current?.loading ? "Stop loading" : "Reload"}
          icon={current?.loading ? "xmark" : "arrow.clockwise"}
          disabled={current === undefined}
          onPress={() => control(current?.loading ? "stop" : "reload")}
        />
        <IconButton
          label="Close tab"
          icon="square.on.square"
          disabled={current === undefined}
          onPress={() => current && void closeBrowserTab(current)}
        />
      </View>
    </View>
  );
}

/** An address typed without a scheme keeps the current page's scheme when it is the same host. */
function withCurrentScheme(text: string, currentUrl: string | null): string {
  if (currentUrl === null || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  try {
    const current = new URL(currentUrl);
    return new URL(`${current.protocol}//${text}`).host === current.host
      ? `${current.protocol}//${text}`
      : text;
  } catch {
    return text;
  }
}

function IconButton(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      className="h-10 w-10 items-center justify-center rounded-full active:bg-subtle"
      style={{ opacity: props.disabled ? 0.35 : 1 }}
    >
      <SymbolView name={props.icon} size={19} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

function TabChip(props: {
  readonly tab: BrowserTab;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onClose: () => void;
}) {
  const label = props.tab.title || props.tab.url || "New Tab";
  return (
    <View
      className={`h-8 flex-row items-center rounded-full pl-3 pr-1 ${props.selected ? "bg-subtle" : ""}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Show ${label}`}
        onPress={props.onSelect}
      >
        <AppText className="max-w-40 text-sm" numberOfLines={1}>
          {label}
        </AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Close ${label}`}
        hitSlop={6}
        onPress={props.onClose}
        className="ml-1 h-6 w-6 items-center justify-center rounded-full"
      >
        <SymbolView name="xmark" size={12} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
    </View>
  );
}
