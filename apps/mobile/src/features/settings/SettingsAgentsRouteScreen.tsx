import { useCallback, useState } from "react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Pressable, TextInput, View } from "react-native";
import { AgentAvatar } from "./AgentAvatar";
import { AgentCheckInsLink } from "./AgentCheckInsLink";
import { AgentGoalsSection } from "./AgentGoalsSection";
import {
  applyAgentToEntries,
  applyAgentToEntry,
  mergeLoadedEntries,
  type AgentEntry,
} from "./agentGoalsLogic";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import { agentKickoffMessage } from "@t3tools/client-runtime/operations/agent-kickoff";
import {
  CommandId,
  MessageId,
  ThreadId,
  type WorkspaceAgent,
  type EnvironmentId,
} from "@t3tools/contracts";
import { agentAvatarShapes, agentIconPaths } from "@t3tools/shared/agentAvatar";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";

type Entry = AgentEntry;
export function SettingsAgentsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const projects = useProjects();
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  const saveCommand = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const updateThread = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [error, setError] = useState("");
  const [memory, setMemory] = useState("");
  const [visibleMessages, setVisibleMessages] = useState(30);
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.all(
        selectedTargets.map(async (target) => {
          const result = await list({ environmentId: target.environmentId, input: {} });
          if (result._tag === "Failure")
            throw new Error("Could not load agents from a selected environment.");
          return result.value.map((agent) => ({ agent, environmentId: target.environmentId }));
        }),
      )
        .then((result) => {
          if (active) {
            const loaded = result.flat();
            setEntries((held) => mergeLoadedEntries(held, loaded));
            // An open agent follows the server too: a goal can pause itself while the inbox is open.
            setSelected((current) =>
              current
                ? loaded.reduce(
                    (entry, next) => applyAgentToEntry(entry, next.environmentId, next.agent),
                    current,
                  )
                : current,
            );
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
      return () => {
        active = false;
      };
    }, [selectedTargets, list]),
  );
  const save = async (agent: WorkspaceAgent, entry: Entry | null = selected) => {
    if (!entry) return;
    const selected = entry;
    const result = await saveCommand({
      environmentId: selected.environmentId,
      input: { agent, expectedRevision: agent.revision },
    });
    if (result._tag === "Failure")
      throw new Error("Agent changed or storage is unavailable. Reopen to refresh before saving.");
    // The Threads list hides agent-owned threads from this same server record.
    appAtomRegistry.refresh(
      serverEnvironment.agentList({ environmentId: selected.environmentId, input: {} }),
    );
    const next = { ...selected, agent: result.value };
    const effectiveModel =
      agent.profile.modelSelection ??
      selectedTargets.find((t) => t.environmentId === selected.environmentId)?.serverConfig.settings
        .defaultModelSelection;
    if (
      agent.primaryThreadId &&
      effectiveModel &&
      JSON.stringify(agent.profile.modelSelection) !==
        JSON.stringify(selected.agent.profile.modelSelection)
    ) {
      const updated = await updateThread({
        environmentId: selected.environmentId,
        input: {
          threadId: ThreadId.make(agent.primaryThreadId),
          modelSelection: effectiveModel,
        },
      });
      if (updated._tag === "Failure")
        setError("Profile saved. Change the conversation model before sending.");
    }
    setSelected((current) => (current ? next : current));
    setEntries((values) =>
      values.map((e) =>
        e.environmentId === next.environmentId && e.agent.profile.id === next.agent.profile.id
          ? next
          : e,
      ),
    );
  };
  const action = (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    void run()
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  /** A goal call returned the saved agent: hold it so the next save carries its new revision. */
  const applyAgent = (next: WorkspaceAgent, environmentId: EnvironmentId) => {
    setSelected((current) => (current ? applyAgentToEntry(current, environmentId, next) : current));
    setEntries((values) => applyAgentToEntries(values, environmentId, next));
    appAtomRegistry.refresh(serverEnvironment.agentList({ environmentId, input: {} }));
  };
  const showCheckIns = () =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsCheckIns" },
    });
  const open = async (entry: Entry | null = selected) => {
    if (!entry) return;
    const { agent, environmentId } = entry;
    let threadId = agent.primaryThreadId;
    let kickoffFailed = false;
    if (!threadId) {
      let projectId = projects.find(
        (p) =>
          p.environmentId === environmentId &&
          JSON.stringify([environmentId, p.id]) === agent.profile.projectKey,
      )?.id;
      if (!projectId) {
        if (agent.profile.projectKey) throw new Error("The assigned project is unavailable.");
        const r = await ensureScratch({ environmentId, input: {} });
        if (r._tag === "Failure") throw new Error("Could not prepare a personal workspace.");
        projectId = r.value.projectId;
      }
      const model =
        agent.profile.modelSelection ??
        selectedTargets.find((t) => t.environmentId === environmentId)?.serverConfig.settings
          .defaultModelSelection;
      if (!model) throw new Error("Select a model below first.");
      threadId = `agent:${agent.profile.id}`;
      const r = await createThread({
        environmentId,
        input: {
          threadId: ThreadId.make(threadId),
          commandId: CommandId.make(`agent-primary-create:${agent.profile.id}`),
          projectId,
          title: agent.profile.name,
          modelSelection: model,
          runtimeMode:
            agent.profile.runtimeMode === "inherit"
              ? "approval-required"
              : agent.profile.runtimeMode,
          prepareAgentWorkspace: true,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (r._tag === "Failure")
        throw new Error("Could not open conversation. No work was submitted.");
      await save(
        {
          ...agent,
          primaryThreadId: threadId,
          threadIds: [...(agent.threadIds ?? []), threadId],
        },
        entry,
      );
      // An agent that is started for the first time with instructions and no earlier history is
      // given its first message so it starts on its purpose, as it does when created on the web.
      // The message id makes a repeat harmless. A failure here must not lose the saved agent.
      const kickoff =
        agent.recovery.disposition === "ready" && !agent.archive?.messages.length
          ? agentKickoffMessage(agent.profile)
          : null;
      if (kickoff) {
        const started = await startTurn({
          environmentId,
          input: {
            threadId: ThreadId.make(threadId),
            message: {
              messageId: MessageId.make(`agent-kickoff:${agent.profile.id}`),
              role: "user",
              text: kickoff,
              attachments: [],
            },
            modelSelection: model,
            runtimeMode:
              agent.profile.runtimeMode === "inherit"
                ? "approval-required"
                : agent.profile.runtimeMode,
            interactionMode: "default",
          },
        });
        kickoffFailed = started._tag === "Failure";
      }
    }
    navigation.navigate("Thread", { environmentId, threadId: ThreadId.make(threadId) });
    if (kickoffFailed)
      setError("The agent was created but could not be started. Send it a message.");
  };
  const upload = async () => {
    if (!selected) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    const image = await ImageManipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width: 256, height: 256 } }],
      { base64: true, format: ImageManipulator.SaveFormat.PNG },
    );
    if (!image.base64) throw new Error("Could not read the image.");
    const { agent } = selected;
    await save({
      ...agent,
      profile: {
        ...agent.profile,
        avatar: {
          kind: "image",
          shape: agent.profile.avatar?.shape ?? "squircle",
          color: agent.profile.color,
          icon: "bot",
          image: `data:image/png;base64,${image.base64}`,
        },
      },
    });
  };
  const agent = selected?.agent;
  const avatar = agent?.profile.avatar;
  return (
    <SettingsScreen title="Your Agents">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 16 }}
      >
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
        {!agent ? (
          <>
            {selectedTargets.length > 0 ? (
              <AgentCheckInsLink environmentIds={selectedTargets.map((t) => t.environmentId)} />
            ) : null}
            {entries
              .filter((e) => !e.agent.archivedAt)
              .map((e) => (
                <View
                  key={`${e.environmentId}:${e.agent.profile.id}`}
                  className="flex-row items-center gap-3 rounded-2xl bg-grouped-card px-3 py-3"
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open conversation with ${e.agent.profile.name}`}
                    className="flex-1 flex-row items-center gap-3"
                    disabled={busy}
                    onPress={() => action(() => open(e))}
                  >
                    <AgentAvatar profile={e.agent.profile} size={44} />
                    <View className="flex-1 gap-0.5">
                      <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                        {e.agent.profile.name}
                      </Text>
                      <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                        {e.agent.profile.description || "Ready for your next task"}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${e.agent.profile.name} details`}
                    className="rounded-full bg-subtle px-3 py-1.5"
                    onPress={() => {
                      setSelected(e);
                      setVisibleMessages(30);
                    }}
                  >
                    <Text className="text-sm text-foreground-muted">Details</Text>
                  </Pressable>
                </View>
              ))}
          </>
        ) : (
          <>
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)}>
              <Text>All Agents</Text>
            </Pressable>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <AgentAvatar profile={agent.profile} />
              <Text>{agent.profile.name}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={busy || !!agent.archivedAt}
              onPress={() => action(() => open())}
            >
              <Text>{busy ? "Saving…" : "Continue Conversation"}</Text>
            </Pressable>
            {agent.recovery.disposition !== "ready" || agent.recovery.blockers.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || !!agent.archivedAt}
                onPress={() =>
                  action(() => {
                    const verifiedAt = new Date().toISOString();
                    return save({
                      ...agent,
                      recovery: {
                        ...agent.recovery,
                        disposition: "ready",
                        blockers: [],
                        verifiedAt,
                        evidence: [
                          ...agent.recovery.evidence,
                          `Confirmed on the phone on ${verifiedAt}: latest source conversation, files, tools and running routines checked.`,
                        ].slice(-100),
                      },
                    });
                  })
                }
              >
                <Text>Messages Are Paused For This Agent. Confirm And Resume Here</Text>
              </Pressable>
            ) : null}
            <Text>Current Work · {agent.recovery.disposition.replaceAll("_", " ")}</Text>
            <Text>{agent.recovery.summary}</Text>
            {[...new Set(agent.recovery.blockers)].map((b) => (
              <Text key={b}>{b}</Text>
            ))}
            <Text>Last Saved: {agent.updatedAt}</Text>
            <Text>{agent.recovery.evidence.join("\n")}</Text>
            {selected ? (
              <AgentGoalsSection
                key={`${selected.environmentId}:${selected.agent.profile.id}`}
                entry={selected}
                connected={selectedTargets.some((t) => t.environmentId === selected.environmentId)}
                locked={busy}
                onBusyChange={setBusy}
                onAgentChange={applyAgent}
                onReviewCheckIns={showCheckIns}
              />
            ) : null}
            <Text>Appearance</Text>
            <Text>Shape</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {Object.keys(agentAvatarShapes).map((shape) => (
                <Pressable
                  accessibilityRole="button"
                  key={shape}
                  disabled={busy}
                  onPress={() =>
                    action(() =>
                      save({
                        ...agent,
                        profile: {
                          ...agent.profile,
                          avatar: {
                            kind: avatar?.kind ?? "bot",
                            shape: shape as keyof typeof agentAvatarShapes,
                            color: avatar?.color ?? agent.profile.color,
                            icon: avatar?.icon ?? "bot",
                            image: avatar?.image ?? null,
                          },
                        },
                      }),
                    )
                  }
                >
                  <Text>{shape}</Text>
                </Pressable>
              ))}
            </View>
            <Text>Icon</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
              {Object.keys(agentIconPaths).map((icon) => (
                <Pressable
                  accessibilityRole="button"
                  key={icon}
                  disabled={busy}
                  onPress={() =>
                    action(() =>
                      save({
                        ...agent,
                        profile: {
                          ...agent.profile,
                          avatar: {
                            kind: "icon",
                            shape: avatar?.shape ?? "squircle",
                            color: avatar?.color ?? agent.profile.color,
                            icon,
                            image: null,
                            imageRef: null,
                          },
                        },
                      }),
                    )
                  }
                >
                  <Text>{icon}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              key={avatar?.color ?? agent.profile.color}
              accessibilityLabel="Avatar Color Hex"
              defaultValue={avatar?.color ?? agent.profile.color}
              maxLength={7}
              onEndEditing={(e) => {
                const color = e.nativeEvent.text;
                if (!/^#[0-9a-f]{6}$/i.test(color)) {
                  setError("Use a six-digit hex color, such as #8054e6.");
                  return;
                }
                action(() =>
                  save({
                    ...agent,
                    profile: {
                      ...agent.profile,
                      color,
                      avatar: {
                        kind: avatar?.kind ?? "bot",
                        shape: avatar?.shape ?? "squircle",
                        color,
                        icon: avatar?.icon ?? "bot",
                        image: avatar?.image ?? null,
                      },
                    },
                  }),
                );
              }}
            />

            <Pressable accessibilityRole="button" disabled={busy} onPress={() => action(upload)}>
              <Text>Upload And Crop Image</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                action(() =>
                  save({
                    ...agent,
                    profile: {
                      ...agent.profile,
                      avatar: {
                        kind: "bot",
                        shape: avatar?.shape ?? "squircle",
                        color: avatar?.color ?? agent.profile.color,
                        icon: "bot",
                        image: null,
                        imageRef: null,
                      },
                    },
                  }),
                )
              }
            >
              <Text>Reset Image</Text>
            </Pressable>
            <Text>Model And Connections</Text>
            {selectedTargets
              .find((t) => t.environmentId === selected?.environmentId)
              ?.serverConfig.providers.map((p) => (
                <View key={p.instanceId}>
                  <Text>
                    {p.instanceId} · {p.status}
                  </Text>
                  {p.models.map((m) => (
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || p.status !== "ready"}
                      key={m.slug}
                      onPress={() =>
                        action(() =>
                          save({
                            ...agent,
                            profile: {
                              ...agent.profile,
                              modelSelection: { instanceId: p.instanceId, model: m.slug },
                            },
                          }),
                        )
                      }
                    >
                      <Text>
                        {agent.profile.modelSelection?.model === m.slug ? "✓ " : ""}
                        {m.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            <Text>Saved Instructions</Text>
            <TextInput
              accessibilityLabel="Agent Instructions"
              multiline
              defaultValue={agent.profile.instructions}
              onEndEditing={(e) =>
                action(() =>
                  save({
                    ...agent,
                    profile: { ...agent.profile, instructions: e.nativeEvent.text },
                  }),
                )
              }
            />
            <Text>Memory</Text>
            {agent.memories.map((m) => (
              <View key={m.id}>
                <Text>
                  {m.origin} · {m.sources.join(", ")}
                </Text>
                <TextInput
                  accessibilityLabel="Edit Memory"
                  multiline
                  defaultValue={m.text}
                  onEndEditing={(e) =>
                    action(() =>
                      save({
                        ...agent,
                        memories: agent.memories.map((row) =>
                          row.id === m.id
                            ? { ...row, text: e.nativeEvent.text, origin: "user" }
                            : row,
                        ),
                      }),
                    )
                  }
                />
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    action(() =>
                      save({ ...agent, memories: agent.memories.filter((row) => row.id !== m.id) }),
                    )
                  }
                >
                  <Text>Remove Memory</Text>
                </Pressable>
              </View>
            ))}
            <TextInput
              accessibilityLabel="New Agent Memory"
              value={memory}
              onChangeText={setMemory}
            />
            <Pressable
              accessibilityRole="button"
              disabled={busy || !memory.trim()}
              onPress={() =>
                action(async () => {
                  await save({
                    ...agent,
                    memories: [
                      ...agent.memories,
                      { id: Crypto.randomUUID(), text: memory, origin: "user", sources: [] },
                    ],
                  });
                  setMemory("");
                })
              }
            >
              <Text>Add Memory</Text>
            </Pressable>
            <Text>Routines</Text>
            <Text>
              {agent.routineOwnershipVerified
                ? "Ownership confirmed. Manage activation in Scheduled Tasks."
                : "Recovered routines remain inactive until dependencies and original ownership are verified."}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsScheduledTasks" },
                })
              }
            >
              <Text>Scheduled Tasks</Text>
            </Pressable>
            <Text>Earlier Conversation In Grok Bot</Text>
            <Text>Historical records. Opening this agent does not resume old requests.</Text>
            {(agent.archive?.messages ?? []).slice(-visibleMessages).map((m) => (
              <View key={m.id}>
                <Text>
                  {m.role} ·{" "}
                  {m.timestampMs ? new Date(m.timestampMs).toLocaleString() : "Date unavailable"}
                </Text>
                <Text selectable>{m.text}</Text>
              </View>
            ))}
            {(agent.archive?.messages.length ?? 0) > visibleMessages && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setVisibleMessages((v) => v + 30)}
              >
                <Text>Show Earlier Messages</Text>
              </Pressable>
            )}
          </>
        )}
        {!entries.length && !error && (
          <Text>Agents appear here from your connected Workbench environment.</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
