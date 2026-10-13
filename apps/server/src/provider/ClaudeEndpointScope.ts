import type { CustomModelSetting, ServerProvider } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";

const ANTHROPIC_API_HOST = "api.anthropic.com";

/**
 * True when `ANTHROPIC_BASE_URL` points somewhere other than Anthropic's own
 * API (a LiteLLM gateway, a proxy, a local server). An unset, blank, or
 * unparseable value counts as Anthropic's API.
 */
export function claudeUsesCustomEndpoint(environment: NodeJS.ProcessEnv): boolean {
  const raw = environment.ANTHROPIC_BASE_URL?.trim();
  if (!raw) return false;
  try {
    return new URL(raw).hostname.toLowerCase() !== ANTHROPIC_API_HOST;
  } catch {
    return false;
  }
}

/**
 * A Claude instance on a different endpoint can only serve what that endpoint
 * serves, which the owner declares as custom models. With at least one custom
 * model the instance lists only those; with none it keeps the built-ins so the
 * list never goes empty.
 */
export function claudeInstanceListsOnlyCustomModels(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly customModels: ReadonlyArray<CustomModelSetting>;
}): boolean {
  return (
    claudeUsesCustomEndpoint(input.environment) &&
    readCustomModelEntries(input.customModels).length > 0
  );
}

/**
 * A snapshot whose models are all custom came from the scoped list above (an
 * ordinary Claude snapshot always carries the built-ins). Merging a previous
 * or cached snapshot must not bring its built-ins back.
 */
export function isCustomOnlyClaudeModelList(
  driver: string,
  models: ReadonlyArray<ServerProvider["models"][number]>,
): boolean {
  return driver === "claudeAgent" && models.length > 0 && models.every((model) => model.isCustom);
}
