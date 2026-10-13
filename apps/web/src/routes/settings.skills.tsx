import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SkillsSettings } from "../components/settings/SkillsSettings";
import { settingsScopeEnvironmentLabel } from "../components/settings/settingsScopeAxis";

/**
 * The skill catalog is machine state. With no machine picked in the scope header the page
 * covers every connected machine; picking one narrows it to that machine.
 */
function SettingsSkillsRoute() {
  const { connectedEnvironments, environments, scope } = useSettingsScope();
  const machines = useMemo(
    () =>
      connectedEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        label: settingsScopeEnvironmentLabel(environment, environments),
      })),
    [connectedEnvironments, environments],
  );
  if (machines.length === 0) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its skills.`
          : "Connect an environment to manage its skills."}
      </p>
    );
  }
  return <SkillsSettings machines={machines} />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
