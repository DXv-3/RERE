import type {
  AccountSignInMode,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { resolveRemoteHostTarget, resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  bootstrapRemoteBearerSession,
  exchangeRemoteAccountAccessToken,
  fetchRemoteAccountSignInMode,
  logoutRemoteAccountSession,
} from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

export interface AccountConnectionInput {
  readonly host: string;
  /**
   * The signed-in account's access token, or null when signed out. `forceRefresh` asks for a new
   * one, used once when the environment refuses the first.
   */
  readonly getAccountToken: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<string | null>;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    /**
     * Whether the environment at `host` offers account sign-in. Advisory: any failure to find out
     * reads as `off`, so the pairing form is never held up by it.
     */
    readonly probeAccountSignIn: (input: {
      readonly host: string;
    }) => Effect.Effect<AccountSignInMode>;
    readonly registerAccount: (
      input: AccountConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    /**
     * Signing out of the account: ends the session of every saved connection the account opened,
     * best effort, then forgets it. Connections opened with a pairing code are not touched.
     * Returns how many were forgotten.
     */
    readonly signOutAccountConnections: () => Effect.Effect<number>;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null) return yield* compatibilityError;
  // No scopes are requested, so the session carries exactly what the pairing
  // link delegates: a standard link pairs a standard client and an
  // administrator link (`t3 pair --admin`) pairs one that can manage access.
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  return bearerRegistration({ descriptor, target, token: access.access_token });
});

const bearerRegistration = (input: {
  readonly descriptor: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly target: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
  readonly token: string;
  readonly openedWith?: "account";
}) => {
  const { descriptor, target } = input;
  const connectionId = `bearer:${descriptor.environmentId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      ...(input.openedWith ? { openedWith: input.openedWith } : {}),
    }),
    credential: new BearerConnectionCredential({
      token: input.token,
    }),
  });
};

const resolveHostTarget = (input: { readonly host: string }) =>
  Effect.try({
    try: () => resolveRemoteHostTarget(input),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment address is invalid.",
      }),
  });

const signedOutError = () =>
  new ConnectionBlockedError({
    reason: "authentication",
    detail: "Sign in to your account first.",
  });

const accountExpiredError = () =>
  new ConnectionBlockedError({
    reason: "authentication",
    detail: "Your account session has expired. Sign in again.",
  });

/**
 * Connects with the signed-in account instead of a pairing code. The session it ends up with is
 * the one a pairing code would have produced; only the credential differs. An access token the
 * environment refuses is replaced once with a refreshed one before giving up.
 */
export const prepareAccountRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareAccountRegistration",
)(function* (input: AccountConnectionInput) {
  const target = yield* resolveHostTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  if (compatibilityError !== null) return yield* compatibilityError;

  const readToken = (options?: { readonly forceRefresh?: boolean }) =>
    Effect.tryPromise({
      try: () => input.getAccountToken(options),
      catch: () => signedOutError(),
    }).pipe(
      Effect.flatMap((token) =>
        token === null ? Effect.fail(signedOutError()) : Effect.succeed(token),
      ),
    );
  const exchange = (accountAccessToken: string) =>
    exchangeRemoteAccountAccessToken({
      httpBaseUrl: target.httpBaseUrl,
      accountAccessToken,
      clientMetadata: presentation.metadata,
    });

  const first = yield* readToken();
  const access = yield* exchange(first).pipe(
    Effect.catchTag("EnvironmentAuthInvalidError", () =>
      readToken({ forceRefresh: true }).pipe(
        Effect.flatMap((refreshed) => exchange(refreshed)),
        Effect.catchTag("EnvironmentAuthInvalidError", () => Effect.fail(accountExpiredError())),
      ),
    ),
    Effect.mapError((error) =>
      error._tag === "ConnectionBlockedError" ? error : mapRemoteEnvironmentError(error),
    ),
  );
  return bearerRegistration({
    descriptor,
    target,
    token: access.access_token,
    openedWith: "account",
  });
});

/** @public The service method wraps this so a failed probe reads as `off`. */
export const probeAccountSignInMode = Effect.fn(
  "clientRuntime.connection.onboarding.probeAccountSignInMode",
)(function* (input: { readonly host: string }) {
  const target = yield* resolveHostTarget(input);
  return yield* fetchRemoteAccountSignInMode({ httpBaseUrl: target.httpBaseUrl });
});

const registerAccountConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerAccountConnection",
)(function* (input: AccountConnectionInput) {
  const registration = yield* prepareAccountRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

const signOutAccountConnections = Effect.fn(
  "clientRuntime.connection.onboarding.signOutAccountConnections",
)(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const opened = [...(yield* SubscriptionRef.get(registry.entries)).values()].flatMap((entry) =>
    entry.target._tag === "BearerConnectionTarget" &&
    Option.isSome(entry.profile) &&
    isBearerProfile(entry.profile.value) &&
    entry.profile.value.openedWith === "account"
      ? [{ environmentId: entry.target.environmentId, profile: entry.profile.value }]
      : [],
  );
  let forgotten = 0;
  for (const { environmentId, profile } of opened) {
    // The server session is ended while the token is still saved; if the machine cannot be
    // reached the token is forgotten anyway, and the session expires or is revoked under
    // Connections on the machine.
    const credential = yield* credentials
      .get(profile.connectionId)
      .pipe(Effect.orElseSucceed(() => Option.none<ConnectionCredential>()));
    if (Option.isSome(credential) && isBearerCredential(credential.value)) {
      yield* logoutRemoteAccountSession({
        httpBaseUrl: profile.httpBaseUrl,
        bearerToken: credential.value.token,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Could not end the account session on the environment.", {
            environmentId,
            error: error._tag,
          }),
        ),
        Effect.ignore,
      );
    }
    const removed = yield* registry.remove(environmentId).pipe(
      Effect.as(true),
      Effect.catchTag("EnvironmentNotRegisteredError", () => Effect.succeed(false)),
      Effect.tapError((error) =>
        Effect.logWarning("Could not forget an account connection.", { environmentId, error }),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (removed) forgotten += 1;
  }
  return forgotten;
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      ...(entry.profile.value.openedWith ? { openedWith: entry.profile.value.openedWith } : {}),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target);
  const connectionId = `ssh:${provisioned.environmentId}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    probeAccountSignIn: (input) =>
      probeAccountSignInMode(input).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.orElseSucceed((): AccountSignInMode => "off"),
      ),
    registerAccount: (input) =>
      registerAccountConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    signOutAccountConnections: () =>
      signOutAccountConnections().pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
