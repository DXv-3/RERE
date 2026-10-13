import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, WorkspaceAgent } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AppText as Text } from "../../components/AppText";
import { AgentAvatar } from "../settings/AgentAvatar";
export function useConversationAgent(environmentId: EnvironmentId, threadId: string) {
  const list = useAtomCommand(serverEnvironment.agentsList, { reportFailure: false });
  const [loaded, setLoaded] = useState<{ key: string; agent: WorkspaceAgent | null } | null>(null);
  const key = JSON.stringify([environmentId, threadId]);
  useEffect(() => {
    let active = true;
    void list({ environmentId, input: {} }).then((result) => {
      if (active && result._tag === "Success")
        setLoaded({
          key,
          agent:
            result.value.find(
              (a) => a.primaryThreadId === threadId || a.threadIds?.includes(threadId),
            ) ?? null,
        });
    });
    return () => {
      active = false;
    };
  }, [environmentId, threadId, key, list]);
  return loaded?.key === key ? loaded.agent : null;
}
export function AgentConversationHistory({ agent }: { agent: WorkspaceAgent }) {
  const [count, setCount] = useState(30);
  const navigation = useNavigation();
  const messages = agent.archive?.messages ?? [];
  return (
    <View style={{ gap: 12, padding: 12 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <AgentAvatar profile={agent.profile} size={42} />
        <Text>{agent.profile.name}</Text>
      </View>
      <Text>{agent.recovery.summary}</Text>
      {agent.recovery.blockers.map((b) => (
        <Text key={b}>{b}</Text>
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsAgents" },
          })
        }
      >
        <Text>Agent Settings And Recovery</Text>
      </Pressable>
      {messages.length > 0 && (
        <Text>Earlier Conversation In Grok Bot · {messages.length} Messages</Text>
      )}
      {messages.length > count && (
        <Pressable accessibilityRole="button" onPress={() => setCount((v) => v + 30)}>
          <Text>Show Earlier Messages</Text>
        </Pressable>
      )}
      {messages.slice(-count).map((m) => (
        <View key={m.id} style={{ gap: 4 }}>
          <Text>
            {m.role === "user" ? "You" : agent.profile.name} ·{" "}
            {m.timestampMs ? new Date(m.timestampMs).toLocaleString() : "Date unavailable"}
          </Text>
          <Text selectable>{m.text}</Text>
        </View>
      ))}
      <Text>Workbench Conversation</Text>
      <Text>
        {agent.recovery.disposition === "ready"
          ? "Reviewed context accompanies new messages."
          : "Review recovery before resuming imported work. Historical requests do not start tasks."}
      </Text>
    </View>
  );
}
