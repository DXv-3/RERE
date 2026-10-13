import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

export const managedEndpointCleanupModeConfig = Config.String("RELAY_TUNNEL_CLEANUP_MODE").pipe(
  Config.withDefault("off"),
  Config.map((value) => value.trim() || "off"),
  Config.mapEffect((value) =>
    decodeManagedEndpointCleanupMode(value).pipe(
      Effect.mapError((error) => new Config.ConfigError(error)),
    ),
  ),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

/** Where invite emails go out, over SMTP with implicit TLS. Present only when all five were set. */
export interface ModelShareEmailSettings {
  readonly host: string;
  /** Always 465: the only port supported. */
  readonly port: number;
  readonly user: string;
  readonly password: Redacted.Redacted<string>;
  /** The From header, for example `CodeWrench <support@example.com>`. */
  readonly from: string;
}

/** Mail is on only with all five settings; the port must be 465. `problem` says why it is off. */
export function resolveModelShareEmailSettings(raw: {
  readonly host: string | undefined;
  readonly port: string | undefined;
  readonly user: string | undefined;
  readonly password: Redacted.Redacted<string> | undefined;
  readonly from: string | undefined;
}): { readonly settings?: ModelShareEmailSettings; readonly problem?: string } {
  const host = raw.host?.trim();
  const port = raw.port?.trim();
  const user = raw.user?.trim();
  const from = raw.from?.trim();
  const password = raw.password;
  if (!host && !port && !user && !from && password === undefined) return {};
  if (!host || !port || !user || !from || password === undefined) {
    return {
      problem:
        "Some of the MODEL_SHARE_SMTP_* / MODEL_SHARE_EMAIL_FROM settings are missing; model share emails are off",
    };
  }
  if (port !== "465") {
    return {
      problem:
        "MODEL_SHARE_SMTP_PORT must be 465 (implicit TLS); model share emails are off until it is",
    };
  }
  return { settings: { host, port: 465, user, password, from } };
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    /** The account sign-in provider's issuer URL, for example a Keycloak realm. */
    readonly oidcIssuer: string;
    readonly oidcAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    /**
     * Encrypts model share tokens at rest. Without it the invite endpoints answer 503 rather than
     * store a token in the clear.
     */
    readonly modelShareSealingKey?: Redacted.Redacted<string>;
    /** Emails the person a share is offered to. Without it no email is sent. */
    readonly modelShareEmail?: ModelShareEmailSettings;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
