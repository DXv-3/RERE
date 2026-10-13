import { checkInsWaitingLabel } from "@t3tools/client-runtime/operations/agent-check-ins";
import type { AgentCheckInFilter, EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

const PENDING: AgentCheckInFilter = { status: "pending" };

type Waiting = { readonly count: number; readonly more: boolean };

/** Reports how many check-ins wait in one environment. Renders nothing. */
function WaitingCounter(props: {
  readonly environmentId: EnvironmentId;
  readonly onChange: (environmentId: EnvironmentId, waiting: Waiting) => void;
}) {
  const { environmentId, onChange } = props;
  const pending = useEnvironmentQuery(
    serverEnvironment.agentCheckInsLive({ environmentId, input: PENDING }),
  );
  const count =
    pending.data?.checkIns.filter((checkIn) => checkIn.status === "pending").length ?? 0;
  const more = pending.data?.nextCursor != null;
  useEffect(() => {
    onChange(environmentId, { count, more });
  }, [environmentId, count, more, onChange]);
  return null;
}

/**
 * A row on the agents screen that opens the check-in inbox, with how many check-ins wait across
 * the environments being shown.
 */
export function AgentCheckInsLink(props: { readonly environmentIds: readonly EnvironmentId[] }) {
  const navigation = useNavigation();
  const [waiting, setWaiting] = useState<Readonly<Record<string, Waiting>>>({});
  const report = useCallback(
    (environmentId: EnvironmentId, next: Waiting) =>
      setWaiting((current) => {
        const held = current[environmentId];
        return held?.count === next.count && held.more === next.more
          ? current
          : { ...current, [environmentId]: next };
      }),
    [],
  );
  const shown = props.environmentIds.flatMap((id) => (waiting[id] ? [waiting[id]] : []));
  const count = shown.reduce((sum, entry) => sum + entry.count, 0);
  const more = shown.some((entry) => entry.more);
  const value = count === 0 ? "Nothing Waiting" : checkInsWaitingLabel(count, more);
  return (
    <>
      {props.environmentIds.map((environmentId) => (
        <WaitingCounter key={environmentId} environmentId={environmentId} onChange={report} />
      ))}
      <SettingsSection>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Check-Ins, ${value}`}
          className="min-h-14 flex-row items-center gap-4 p-4 active:opacity-70"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsCheckIns" },
            })
          }
        >
          <SymbolView
            name="checkmark.circle"
            size={22}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
          <Text className="shrink-0 text-lg text-foreground">Check-Ins</Text>
          <View className="min-w-0 flex-1 items-end">
            <Text
              className={
                count > 0
                  ? "text-right text-base font-t3-medium text-primary-text"
                  : "text-right text-base text-foreground-muted"
              }
              numberOfLines={1}
            >
              {value}
            </Text>
          </View>
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      </SettingsSection>
    </>
  );
}
