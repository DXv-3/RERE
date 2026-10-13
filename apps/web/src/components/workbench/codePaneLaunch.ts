import type { ServerProvider } from "@t3tools/contracts";
import type { CodePane } from "./workbenchStore";

/** The provider driver whose models a CLI pane can be started with. */
export const paneDrivers: Partial<Record<CodePane["kind"], string>> = {
  claude: "claudeAgent",
  codex: "codex",
};
export { launchCommand, paneEnvironment } from "@t3tools/shared/codePaneLaunch";

/**
 * Models offered for a CLI pane. Only the driver's default account counts: other
 * accounts on the same driver point at other endpoints the bare CLI does not know.
 */
export function paneModels(
  providers: ReadonlyArray<ServerProvider>,
  kind: CodePane["kind"],
): ReadonlyArray<{ slug: string; name: string }> {
  const driver = paneDrivers[kind];
  const seen = new Map<string, string>();
  for (const provider of providers)
    if (provider.driver === driver && provider.instanceId === driver && provider.enabled)
      for (const model of provider.models)
        if (!model.isLegacy && !seen.has(model.slug))
          seen.set(model.slug, model.shortName ?? model.name);
  return [...seen].map(([slug, name]) => ({ slug, name }));
}
