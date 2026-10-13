import type { AccountAuthConfig } from "@t3tools/shared/accountAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    oidcIssuer: normalizeSecureUrl(trimNonEmpty(import.meta.env.VITE_OIDC_ISSUER) ?? ""),
    oidcClientId: trimNonEmpty(import.meta.env.VITE_OIDC_CLIENT_ID),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.oidcIssuer && config.oidcClientId && config.relayUrl);
}

/** The account sign-in provider, or null when this build has no account sign-in. */
export function resolveAccountAuthConfig(): AccountAuthConfig | null {
  const { oidcIssuer, oidcClientId } = resolveCloudPublicConfig();
  return oidcIssuer && oidcClientId ? { issuer: oidcIssuer, clientId: oidcClientId } : null;
}
