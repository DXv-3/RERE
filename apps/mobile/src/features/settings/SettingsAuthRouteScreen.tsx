import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { type AccountSignInResult, useAccountSession } from "../cloud/AccountSessionProvider";
import { useManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { T3ConnectServersSection } from "../cloud/T3ConnectServersSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

/**
 * Sign in or create an account (both open the hosted pages in the system browser), or, once
 * signed in, manage the account and the servers registered to it.
 */
function ConfiguredSettingsAuthRouteScreen() {
  const insets = useSafeAreaInsets();
  const { isLoaded, isSignedIn, identity, signIn, signUp, signOut, openAccount } =
    useAccountSession();
  const environmentsState = useManagedRelayEnvironments();
  const [pendingAction, setPendingAction] = useState<"sign_in" | "sign_up" | "sign_out" | null>(
    null,
  );

  const runAuthentication = useCallback(
    async (action: "sign_in" | "sign_up", start: () => Promise<AccountSignInResult>) => {
      if (pendingAction !== null) return;
      setPendingAction(action);
      const result = await start();
      setPendingAction(null);
      if (result.status === "failed") Alert.alert("Could not sign in", result.message);
    },
    [pendingAction],
  );

  const handleSignOut = useCallback(async () => {
    if (pendingAction !== null) return;
    setPendingAction("sign_out");
    await signOut();
    setPendingAction(null);
  }, [pendingAction, signOut]);

  const busy = pendingAction !== null;

  return (
    <SettingsScreen title="CodeWrench Account">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          isSignedIn ? (
            <RefreshControl
              refreshing={environmentsState.isPending && environmentsState.data !== null}
              onRefresh={environmentsState.refresh}
            />
          ) : undefined
        }
      >
        {!isLoaded ? (
          <View className="items-center py-10">
            <ActivityIndicator />
          </View>
        ) : isSignedIn ? (
          <>
            <SettingsSection title="Signed In As">
              <View className="p-4">
                <Text className="text-lg text-foreground" numberOfLines={1}>
                  {identity?.email ?? identity?.name ?? "CodeWrench account"}
                </Text>
              </View>
            </SettingsSection>
            <SettingsSection>
              <SettingsActionRow
                icon="globe"
                label="Manage Account"
                disabled={busy}
                onPress={() => void openAccount()}
              />
              <SettingsActionRow
                icon="xmark"
                label="Sign Out"
                tone="danger"
                disabled={busy}
                loading={pendingAction === "sign_out"}
                onPress={() => void handleSignOut()}
              />
            </SettingsSection>
            <T3ConnectServersSection environmentsState={environmentsState} />
          </>
        ) : (
          <>
            <Text className="px-2 text-sm leading-normal text-foreground-muted">
              Sign in to your CodeWrench account to reach your servers through CodeWrench Connect
              and receive agent notifications on this device.
            </Text>
            <SettingsSection>
              <SettingsActionRow
                icon="arrow.right"
                label="Sign In"
                disabled={busy}
                loading={pendingAction === "sign_in"}
                onPress={() => void runAuthentication("sign_in", signIn)}
              />
              <SettingsActionRow
                icon="person.crop.circle"
                label="Create Account"
                disabled={busy}
                loading={pendingAction === "sign_up"}
                onPress={() => void runAuthentication("sign_up", signUp)}
              />
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
