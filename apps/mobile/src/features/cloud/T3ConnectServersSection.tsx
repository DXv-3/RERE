import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { type ReactNode, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  deregisterManagedRelayEnvironmentCommand,
  type useManagedRelayEnvironments,
} from "./managedRelayState";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime())
    ? "Link date unavailable"
    : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

function confirmDeregister(environment: RelayClientEnvironmentRecord, onConfirm: () => void) {
  const title = "Deregister server?";
  const message = `“${environment.label}” will be removed from this account. CodeWrench Connect access will be revoked, any managed tunnel will be removed, and a host space will become available. Local connections on your devices are not changed.`;
  if (process.env.EXPO_OS === "ios") {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Deregister", style: "destructive", onPress: onConfirm },
    ]);
    return;
  }
  showConfirmDialog({ title, message, confirmText: "Deregister", destructive: true, onConfirm });
}

/**
 * Every environment registered to the signed-in account, with account-level
 * deregistration. Mirrors the web account menu page; connections on this
 * device are managed in Settings instead. The owning screen supplies the
 * environments state so it can drive pull-to-refresh.
 */
export function T3ConnectServersSection(props: {
  readonly environmentsState: ReturnType<typeof useManagedRelayEnvironments>;
}) {
  const { environmentsState } = props;
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const mutationPendingRef = useRef(false);
  // Deregistered rows stay in the cached list until the refresh lands, so hide
  // them by the linkedAt they had. A re-link produces a new linkedAt and shows again.
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);

    if (result._tag === "Success") {
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      environmentsState.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not deregister the server.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    Alert.alert(
      "Could not deregister server",
      traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
      traceId
        ? [
            {
              text: "Copy trace ID",
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: "OK", style: "cancel" },
          ]
        : undefined,
    );
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);
  const errorTraceId = environmentsState.errorTraceId;

  return (
    <View className="gap-2">
      <SettingsSection title="Registered Servers">
        {environmentsState.error ? (
          <>
            <ServerRow
              title="Could not load CodeWrench Connect environments"
              subtitle={environmentsState.error}
            />
            {errorTraceId ? (
              <ServerButtonRow
                label="Copy Trace ID"
                onPress={() => {
                  copyTextWithHaptic(errorTraceId, { target: "connection-trace-id" });
                }}
              />
            ) : null}
          </>
        ) : isInitialLoad ? (
          <View className="flex-row items-center gap-3 p-4">
            <ActivityIndicator colorClassName={"accent-foreground-muted"} size="small" />
            <Text className="text-base text-foreground-muted">Loading environments</Text>
          </View>
        ) : environments.length > 0 ? (
          environments.map((environment, index) => (
            <ServerRow
              key={environment.environmentId}
              first={index === 0}
              title={environment.label}
              subtitle={`${linkedAtLabel(environment.linkedAt)} · ${endpointLabel(environment)}`}
              accessory={
                deregisteringEnvironmentId === environment.environmentId ? (
                  <ActivityIndicator colorClassName={"accent-foreground-muted"} size="small" />
                ) : (
                  <ControlPillMenu
                    actions={ENVIRONMENT_MENU_ACTIONS}
                    isAnchoredToRight
                    onPressAction={() =>
                      confirmDeregister(environment, () => void handleDeregister(environment))
                    }
                  >
                    <Pressable
                      accessibilityLabel={`Actions for ${environment.label}`}
                      accessibilityRole="button"
                      disabled={deregisteringEnvironmentId !== null}
                      className="size-[30px] items-center justify-center active:opacity-60 disabled:opacity-50"
                    >
                      <View className="rotate-90">
                        <SymbolView
                          name="ellipsis"
                          size={18}
                          tintColorClassName={"accent-foreground-muted"}
                          type="monochrome"
                        />
                      </View>
                    </Pressable>
                  </ControlPillMenu>
                )
              }
            />
          ))
        ) : (
          <ServerRow
            title="No servers registered"
            subtitle="Link a server from its local Settings to reach it through CodeWrench Connect."
          />
        )}
      </SettingsSection>

      <Text className="px-2 text-xs leading-normal text-foreground-muted">
        Connections on this device are managed in Settings.
      </Text>
    </View>
  );
}

const ENVIRONMENT_MENU_ACTIONS = [
  { id: "deregister", title: "Deregister", image: "trash", attributes: { destructive: true } },
] satisfies MenuAction[];

function ServerRow(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly first?: boolean;
  readonly accessory?: ReactNode;
}) {
  return (
    <View
      collapsable={false}
      className={cn(
        "flex-row items-center gap-3 p-4",
        props.first === false && "border-t border-separator",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {props.subtitle}
        </Text>
      </View>
      {props.accessory}
    </View>
  );
}

function ServerButtonRow(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="border-t border-separator p-4 active:opacity-60"
    >
      <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
