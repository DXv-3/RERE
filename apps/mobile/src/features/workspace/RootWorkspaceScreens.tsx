import { CodeTerminalsRouteScreen } from "../code/CodeTerminalsRouteScreen";
import { SettingsAgentsRouteScreen } from "../settings/SettingsAgentsRouteScreen";
import { SettingsEnvironmentFilterProvider } from "../settings/settings-environment-filter";

/**
 * Agents and Code as full screens beside the thread list, like the desktop's
 * tabs. Both screens read the connected servers from the settings filter, so
 * each gets its own provider outside the settings sheet.
 */
export function AgentsRootRouteScreen() {
  return (
    <SettingsEnvironmentFilterProvider>
      <SettingsAgentsRouteScreen />
    </SettingsEnvironmentFilterProvider>
  );
}

export function CodeRootRouteScreen() {
  return (
    <SettingsEnvironmentFilterProvider>
      <CodeTerminalsRouteScreen />
    </SettingsEnvironmentFilterProvider>
  );
}
