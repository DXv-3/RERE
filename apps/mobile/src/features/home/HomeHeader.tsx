import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import type { HomeHeaderProps } from "./HomeHeader.types";

import { SESSION_FILTER_CHOICES } from "../../lib/sessionFilter";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const navigation = useNavigation();
  const iconColor = useUniwindTheme()["--color-icon"];
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const hasCustomListOptions =
    props.sessionFilter !== "all" ||
    props.selectedEnvironmentId !== null ||
    props.selectedProjectKey !== null;
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={filterMenu.items}
        options={{
          // Static header config (glass, title, fonts) lives in Stack.tsx
          // (GLASS_HEADER_OPTIONS). Only dynamic values are set here.
          headerTintColor: iconColor,
          unstable_headerRightItems: () => [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open Code terminals",
              icon: { name: "terminal", type: "sfSymbol" } as const,
              identifier: "home-code",
              label: "",
              onPress: () => navigation.navigate("Code"),
              type: "button",
            }),
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open your agents",
              icon: { name: "person.2", type: "sfSymbol" } as const,
              identifier: "home-agents",
              label: "",
              onPress: () => navigation.navigate("Agents"),
              type: "button",
            }),
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open settings",
              icon: { name: "ellipsis", type: "sfSymbol" } as const,
              identifier: "home-settings",
              label: "",
              onPress: props.onOpenSettings,
              type: "button",
            }),
          ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by NativeHeaderToolbar.
          ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
            ? {
                unstable_headerToolbarItems: () => [
                  createNativeMailSearchToolbarItem({
                    composeButtonId: "home-new-task",
                    composeSystemImageName: "square.and.pencil",
                    filterMenu,
                    filterButtonId: "home-filter",
                    filterSystemImageName: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease",
                    onComposePress: props.onStartNewTask,
                    onSearchTextChange: props.onSearchQueryChange,
                    placeholder: "Search",
                    searchTextChangeId: "home-search-text",
                    showsSearchDismissButton: true,
                  }),
                ],
              }
            : {
                // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                // bar; create + sort live in the plain bottom toolbar below.
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => {
                    props.onSearchQueryChange("");
                  },
                  onChangeText: (event) => {
                    props.onSearchQueryChange(event.nativeEvent.text);
                  },
                },
              }),
        }}
      />

      {NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <NativeHeaderToolbar.Menu title="Sessions">
              <NativeHeaderToolbar.Label>Sessions</NativeHeaderToolbar.Label>
              {SESSION_FILTER_CHOICES.map((choice) => (
                <NativeHeaderToolbar.MenuAction
                  key={choice.value}
                  isOn={props.sessionFilter === choice.value}
                  onPress={() => props.onSessionFilterChange(choice.value)}
                >
                  <NativeHeaderToolbar.Label>{choice.title}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
              >
                <NativeHeaderToolbar.Label>All environments</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            {props.projects.length > 0 ? (
              <NativeHeaderToolbar.Menu title="Project">
                <NativeHeaderToolbar.Label>Project</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.projects.map((project) => (
                  <NativeHeaderToolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <NativeHeaderToolbar.Label>{project.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}
          </NativeHeaderToolbar.Menu>
          <NativeHeaderToolbar.Spacer flexible />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
