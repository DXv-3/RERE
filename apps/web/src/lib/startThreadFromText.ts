import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

/**
 * The model a thread started without a composer runs on: the configured
 * default, else the first usable provider's default model.
 */
export function resolveStartModelSelection(
  configuredDefault: ModelSelection | null | undefined,
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly isDefault?: boolean | undefined;
    }>;
  }>,
): ModelSelection | null {
  if (configuredDefault) return configuredDefault;
  for (const provider of providers) {
    if (!provider.enabled || !provider.isAvailable) continue;
    const model = provider.models.find((entry) => entry.isDefault) ?? provider.models[0];
    if (model) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}
