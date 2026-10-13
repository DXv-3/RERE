import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import {
  CODE_THREAD_PREFIX,
  launchCommand,
  paneActivity,
  paneEnvironment,
  type CodePaneKind,
  type PaneActivity,
} from "@t3tools/shared/codePaneLaunch";
import * as Crypto from "expo-crypto";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { stagePendingTerminalLaunch } from "../terminal/terminalLaunchContext";

const ACTIVITY_LABELS: Record<PaneActivity, string> = {
  starting: "Starting",
  shell: "At Shell",
  running: "Running",
  working: "Working",
  "needs-you": "Needs You",
  idle: "Idle",
  ended: "Ended",
};
const URGENCY: ReadonlyArray<PaneActivity> = [
  "needs-you",
  "working",
  "running",
  "starting",
  "idle",
  "shell",
  "ended",
];
const NEW_KINDS = [
  { kind: "claude", label: "Claude" },
  { kind: "codex", label: "Codex" },
  { kind: "shell", label: "Shell" },
] as const satisfies ReadonlyArray<{ kind: CodePaneKind; label: string }>;

const lastSegment = (path: string) => path.split(/[\\/]/).findLast(Boolean) ?? path;

/**
 * The Code tab for a phone: every Code terminal running on the selected
 * servers, including ones started from the desktop, and a way to start one.
 */
export function CodeTerminalsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsScreen title="Code">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 20 }}
      >
        {selectedTargets.map((target) => (
          <EnvironmentCode
            key={target.environmentId}
            environmentId={target.environmentId}
            label={target.label}
          />
        ))}
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Connect to a server to see its terminals.</Text>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentCode(props: { readonly environmentId: EnvironmentId; readonly label: string }) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const sessions = useKnownTerminalSessions({ environmentId, threadId: null })
    .filter(
      (session) =>
        session.target.threadId.startsWith(CODE_THREAD_PREFIX) &&
        (session.state.status === "running" || session.state.status === "starting"),
    )
    .map((session) => ({ session, activity: paneActivity(session.state) }))
    .sort((a, b) => URGENCY.indexOf(a.activity) - URGENCY.indexOf(b.activity));

  const projectTitle = (threadId: string) => {
    const projectId = threadId.slice(CODE_THREAD_PREFIX.length);
    return projects.find((project) => project.id === projectId)?.title ?? null;
  };
  const openTerminal = (threadId: ThreadId, terminalId: string, title: string) =>
    navigation.navigate("CodeTerminal", {
      environmentId: String(environmentId),
      threadId: String(threadId),
      terminalId,
      title,
    });
  const start = (project: (typeof projects)[number], kind: CodePaneKind, label: string) => {
    const threadId = ThreadId.make(`${CODE_THREAD_PREFIX}${project.id}`);
    const terminalId = `code-${Crypto.randomUUID()}`;
    const command = launchCommand(kind);
    const env = paneEnvironment(kind);
    stagePendingTerminalLaunch({
      target: { environmentId, threadId, terminalId },
      launch: {
        cwd: project.workspaceRoot,
        worktreePath: null,
        ...(env ? { env } : {}),
        ...(command ? { initialInput: `${command}\r` } : {}),
      },
    });
    openTerminal(threadId, terminalId, `${label} · ${project.title}`);
  };

  return (
    <View className="gap-4">
      <SettingsSection title={`Running On ${props.label}`}>
        {sessions.length === 0 ? (
          <Text className="px-3 py-3 text-foreground-muted">No Code terminals are running.</Text>
        ) : (
          sessions.map(({ session, activity }) => {
            const cwd = session.state.summary?.cwd ?? "";
            const name = projectTitle(session.target.threadId) ?? lastSegment(cwd);
            const running = session.state.hasRunningSubprocess
              ? (session.state.summary?.label ?? "")
              : "";
            return (
              <Pressable
                key={`${session.target.threadId}:${session.target.terminalId}`}
                accessibilityRole="button"
                accessibilityLabel={`Open terminal in ${name}`}
                className="flex-row items-center gap-3 px-3 py-3"
                onPress={() =>
                  openTerminal(
                    session.target.threadId,
                    session.target.terminalId,
                    running ? `${running} · ${name}` : name,
                  )
                }
              >
                <View className="flex-1 gap-0.5">
                  <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                    {running ? `${running} · ${name}` : name}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {cwd}
                  </Text>
                </View>
                <View className="rounded-full bg-subtle px-2.5 py-1">
                  <Text className="text-xs font-t3-medium text-foreground-muted">
                    {ACTIVITY_LABELS[activity]}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </SettingsSection>
      <SettingsSection title="Start A Terminal">
        {projects.length === 0 ? (
          <Text className="px-3 py-3 text-foreground-muted">This server has no projects yet.</Text>
        ) : (
          projects.map((project) => (
            <View key={project.id} className="gap-2 px-3 py-3">
              <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                {project.title}
              </Text>
              <View className="flex-row gap-2">
                {NEW_KINDS.map(({ kind, label }) => (
                  <Pressable
                    key={kind}
                    accessibilityRole="button"
                    accessibilityLabel={`Start ${label} in ${project.title}`}
                    className="rounded-full bg-subtle px-3 py-1.5"
                    onPress={() => start(project, kind, label)}
                  >
                    <Text className="text-sm text-foreground">{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </SettingsSection>
    </View>
  );
}
