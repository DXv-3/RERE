import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { TerminalSurface } from "../terminal/NativeTerminalSurface";
import { takePendingTerminalLaunch } from "../terminal/terminalLaunchContext";
import { getMobileTerminalTheme } from "../terminal/terminalTheme";

// Keys a phone keyboard lacks but a CLI needs.
const EXTRA_KEYS = [
  { label: "esc", data: "\u001b" },
  { label: "tab", data: "\t" },
  { label: "ctrl-c", data: "\u0003" },
  { label: "↑", data: "\u001b[A" },
  { label: "↓", data: "\u001b[B" },
  { label: "←", data: "\u001b[D" },
  { label: "→", data: "\u001b[C" },
  { label: "enter", data: "\r" },
] as const;

/**
 * One Code-tab terminal, full screen. Code terminals hang off a per-project
 * id rather than a real thread, so this screen takes the terminal's own
 * coordinates instead of resolving a thread.
 */
export function CodeTerminalRouteScreen(
  props: StaticScreenProps<{
    readonly environmentId: string;
    readonly threadId: string;
    readonly terminalId: string;
    readonly title?: string;
  }>,
) {
  const { terminalId, title } = props.route.params;
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { appearance, themeAppearance, themeId } = useAppearancePreferences();
  const theme = getMobileTerminalTheme(themeId, themeAppearance);
  const write = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const resize = useAtomCommand(terminalEnvironment.resize, { reportFailure: false });

  // A terminal started from the phone arrives with its launch staged; one that
  // already runs is found in the server's session list.
  const [launch] = useState(() =>
    takePendingTerminalLaunch({ environmentId, threadId, terminalId }),
  );
  const known = useKnownTerminalSessions({ environmentId, threadId });
  const knownCwd =
    known.find((session) => session.target.terminalId === terminalId)?.state.summary?.cwd ?? null;
  // Latched on first sight so a later summary update cannot re-attach the terminal.
  const [latchedCwd, setLatchedCwd] = useState<string | null>(launch?.cwd ?? null);
  if (latchedCwd === null && knownCwd !== null) setLatchedCwd(knownCwd);
  const cwd = latchedCwd ?? knownCwd;

  const attachInput = useMemo(
    () =>
      cwd === null
        ? null
        : {
            threadId,
            terminalId,
            cwd,
            ...(launch?.env ? { env: launch.env } : {}),
            ...(launch ? { restartIfNotRunning: true } : {}),
          },
    [cwd, launch, terminalId, threadId],
  );
  const terminal = useAttachedTerminalSession({ environmentId, terminal: attachInput });
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  useEffect(() => {
    navigation.setOptions({ title: title ?? "Terminal" });
  }, [navigation, title]);

  const send = (data: string) => {
    void write({ environmentId, input: { threadId, terminalId, data } });
  };

  // The CLI is started by typing its command into the new shell, once.
  const sentInitialInput = useRef(false);
  useEffect(() => {
    if (!launch?.initialInput || sentInitialInput.current || terminal.version === 0) return;
    sentInitialInput.current = true;
    void write({ environmentId, input: { threadId, terminalId, data: launch.initialInput } });
  }, [environmentId, launch, terminal.version, terminalId, threadId, write]);

  return (
    <View className="flex-1" style={{ backgroundColor: theme.background }}>
      {attachInput === null ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-foreground-muted">
            Looking for this terminal on the server…
          </Text>
        </View>
      ) : (
        <TerminalSurface
          autoFocus
          buffer={terminal.buffer}
          fontSize={appearance.terminalFontSize}
          isRunning={isRunning}
          onInput={send}
          onResize={({ cols, rows }) => {
            void resize({ environmentId, input: { threadId, terminalId, cols, rows } });
          }}
          style={{ flex: 1 }}
          terminalKey={`${environmentId}:${threadId}:${terminalId}`}
          theme={theme}
        />
      )}
      <KeyboardStickyView>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          className="bg-card-alt"
          contentContainerStyle={{
            gap: 8,
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 8),
          }}
        >
          {EXTRA_KEYS.map((key) => (
            <Pressable
              key={key.label}
              accessibilityRole="button"
              accessibilityLabel={`Send ${key.label}`}
              className="rounded-lg bg-subtle px-3 py-2"
              disabled={!isRunning}
              onPress={() => send(key.data)}
            >
              <Text className="text-sm font-t3-medium text-foreground">{key.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </KeyboardStickyView>
    </View>
  );
}
