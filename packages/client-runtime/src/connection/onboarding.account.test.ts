import {
  AuthAdministrativeScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { BearerConnectionTarget } from "./model.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import { prepareAccountRegistration, probeAccountSignInMode } from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";

const PRESENTATION = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: { label: "T3 Code Test", deviceType: "desktop", os: "Test OS" },
    scopes: AuthAdministrativeScopes,
  }),
);

const TRACE = { traceId: "trace-1" };
const refused = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      ...TRACE,
    },
    { status: 401 },
  );
const notOwner = () =>
  Response.json(
    { _tag: "EnvironmentAccountNotOwnerError", code: "account_not_owner", ...TRACE },
    { status: 403 },
  );
const unavailable = () =>
  Response.json(
    {
      _tag: "EnvironmentAccountSignInUnavailableError",
      code: "account_sign_in_unavailable",
      ...TRACE,
    },
    { status: 404 },
  );
const issued = (token: string) =>
  Response.json({
    access_token: token,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "Bearer",
    expires_in: 2_592_000,
    scope: AuthAdministrativeScopes.join(" "),
  });

function environment(
  tokenResponses: ReadonlyArray<() => Response>,
  options?: { readonly accountSignIn?: "allowed" | "required" },
) {
  const calls: Array<{ readonly url: string; readonly body: URLSearchParams }> = [];
  let next = 0;
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    const body =
      init.body instanceof Uint8Array
        ? new URLSearchParams(new TextDecoder().decode(init.body))
        : new URLSearchParams(String(init.body ?? ""));
    calls.push({ url, body });
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: "environment-account",
          label: "Owner machine",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: false,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          ...(options?.accountSignIn ? { accountSignIn: options.accountSignIn } : {}),
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      const respond = tokenResponses[next] ?? tokenResponses.at(-1);
      next += 1;
      return Promise.resolve(respond?.() ?? refused());
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;
  return { calls, layer: Layer.mergeAll(PRESENTATION, remoteHttpClientLayer(fetchFn)) };
}

const tokens = (...values: ReadonlyArray<string | null>) => {
  const requests: Array<{ readonly forceRefresh: boolean }> = [];
  let index = 0;
  return {
    requests,
    getAccountToken: async (options?: { readonly forceRefresh?: boolean }) => {
      requests.push({ forceRefresh: options?.forceRefresh === true });
      const value = values[Math.min(index, values.length - 1)] ?? null;
      index += 1;
      return value;
    },
  };
};

const tokenCalls = <T extends { readonly url: string }>(calls: ReadonlyArray<T>) =>
  calls.filter((call) => call.url.endsWith("/oauth/token"));

describe("connection onboarding with an account", () => {
  it.effect(
    "stores the same bearer registration a pairing code would, from the account token",
    () =>
      Effect.gen(function* () {
        const env = environment([() => issued("bearer-from-account")]);
        const account = tokens("account-token");
        const registration = yield* prepareAccountRegistration({
          host: "remote.example.test",
          getAccountToken: account.getAccountToken,
        }).pipe(Effect.provide(env.layer));

        expect(registration).toMatchObject({
          _tag: "BearerConnectionRegistration",
          target: {
            environmentId: "environment-account",
            connectionId: "bearer:environment-account",
          },
          profile: {
            httpBaseUrl: "https://remote.example.test/",
            wsBaseUrl: "wss://remote.example.test/",
          },
          credential: { token: "bearer-from-account" },
        });
        // The connection remembers it came from the account, so signing out can find it.
        expect(registration.profile.openedWith).toBe("account");
        const [request] = tokenCalls(env.calls);
        expect(request?.body.get("subject_token")).toBe("account-token");
        expect(request?.body.get("subject_token_type")).toBe(
          "urn:t3:params:oauth:token-type:account-access-token",
        );
        // The owner's scopes are decided by the server, so none are requested.
        expect(request?.body.get("scope")).toBeNull();
        expect(request?.body.get("client_label")).toBe("T3 Code Test");
        expect(account.requests).toEqual([{ forceRefresh: false }]);
      }),
  );

  it.effect("refreshes the account token once when the environment refuses it", () =>
    Effect.gen(function* () {
      const env = environment([refused, () => issued("bearer-after-refresh")]);
      const account = tokens("stale", "fresh");
      const registration = yield* prepareAccountRegistration({
        host: "remote.example.test",
        getAccountToken: account.getAccountToken,
      }).pipe(Effect.provide(env.layer));
      expect(registration.credential.token).toBe("bearer-after-refresh");
      expect(account.requests).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
      expect(tokenCalls(env.calls).map((call) => call.body.get("subject_token"))).toEqual([
        "stale",
        "fresh",
      ]);
    }),
  );

  it.effect("asks for a new sign-in when the refreshed token is refused too", () =>
    Effect.gen(function* () {
      const env = environment([refused]);
      const account = tokens("stale", "still-bad");
      const error = yield* prepareAccountRegistration({
        host: "remote.example.test",
        getAccountToken: account.getAccountToken,
      }).pipe(Effect.provide(env.layer), Effect.flip);
      expect(error).toMatchObject({ reason: "authentication" });
      expect(error.message).toContain("Sign in again");
      expect(tokenCalls(env.calls)).toHaveLength(2);
    }),
  );

  it.effect("does not call the environment's token endpoint when signed out", () =>
    Effect.gen(function* () {
      const env = environment([() => issued("never")]);
      const error = yield* prepareAccountRegistration({
        host: "remote.example.test",
        getAccountToken: tokens(null).getAccountToken,
      }).pipe(Effect.provide(env.layer), Effect.flip);
      expect(error).toMatchObject({
        reason: "authentication",
        message: "Sign in to your account first.",
      });
      expect(tokenCalls(env.calls)).toHaveLength(0);
    }),
  );

  it.effect("says the environment belongs to someone else, without retrying", () =>
    Effect.gen(function* () {
      const env = environment([notOwner]);
      const account = tokens("account-token", "other");
      const error = yield* prepareAccountRegistration({
        host: "remote.example.test",
        getAccountToken: account.getAccountToken,
      }).pipe(Effect.provide(env.layer), Effect.flip);
      expect(error).toMatchObject({ reason: "permission" });
      expect(error.message).toContain("belongs to a different account");
      expect(tokenCalls(env.calls)).toHaveLength(1);
      expect(account.requests).toHaveLength(1);
    }),
  );

  it.effect("points to a pairing code when the environment does not offer account sign-in", () =>
    Effect.gen(function* () {
      const env = environment([unavailable]);
      const error = yield* prepareAccountRegistration({
        host: "remote.example.test",
        getAccountToken: tokens("account-token").getAccountToken,
      }).pipe(Effect.provide(env.layer), Effect.flip);
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("pairing code");
    }),
  );

  it.effect("rejects an empty address before any request", () =>
    Effect.gen(function* () {
      const env = environment([]);
      const error = yield* prepareAccountRegistration({
        host: " ",
        getAccountToken: tokens("account-token").getAccountToken,
      }).pipe(Effect.provide(env.layer), Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(env.calls).toEqual([]);
    }),
  );

  it.effect("learns the account sign-in mode from the unauthenticated session state", () =>
    Effect.gen(function* () {
      for (const mode of ["allowed", "required", undefined] as const) {
        const env = environment([], mode ? { accountSignIn: mode } : undefined);
        const found = yield* probeAccountSignInMode({ host: "remote.example.test" }).pipe(
          Effect.provide(env.layer),
        );
        expect(found).toBe(mode ?? "off");
        expect(env.calls.map((call) => call.url)).toEqual([
          "https://remote.example.test/api/auth/session",
        ]);
      }
    }),
  );
});

describe("signing out of the account", () => {
  const entryFor = (id: string, openedWith: "account" | undefined): ConnectionCatalogEntry => {
    const environmentId = EnvironmentId.make(id);
    const connectionId = `bearer:${id}`;
    return {
      target: new BearerConnectionTarget({ environmentId, label: id, connectionId }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId,
          label: id,
          httpBaseUrl: `https://${id}.example.test/`,
          wsBaseUrl: `wss://${id}.example.test/`,
          ...(openedWith ? { openedWith } : {}),
        }),
      ),
      enabled: true,
    };
  };

  const run = (
    saved: ReadonlyArray<ConnectionCatalogEntry>,
    options?: { readonly unreachable?: ReadonlyArray<string> },
  ) =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      const fetchFn = ((input, init = {}) => {
        const url = String(input);
        const headers = new Headers(init.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        if (options?.unreachable?.some((host) => url.includes(host))) {
          return Promise.reject(new TypeError("offline"));
        }
        return Promise.resolve(Response.json({ signedOut: true }));
      }) satisfies typeof fetch;
      const removed: string[] = [];
      const entries = yield* SubscriptionRef.make(
        new Map(saved.map((entry) => [entry.target.environmentId, entry])),
      );
      const registry = {
        entries,
        remove: (environmentId: EnvironmentId) =>
          Effect.sync(() => void removed.push(environmentId)),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
      const credentials = ConnectionCredentialStore.make({
        get: (connectionId) =>
          Effect.succeed(
            Option.some(new BearerConnectionCredential({ token: `token-${connectionId}` })),
          ),
        put: () => Effect.void,
        remove: () => Effect.void,
      });
      const onboarding = yield* ConnectionOnboarding.make.pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          {} as ClientCapabilities.SshEnvironmentGateway["Service"],
        ),
        Effect.provide(Layer.mergeAll(PRESENTATION, remoteHttpClientLayer(fetchFn))),
      );
      const forgotten = yield* onboarding.signOutAccountConnections();
      return { forgotten, removed, requests };
    });

  it.effect("ends and forgets the connections the account opened, and only those", () =>
    Effect.gen(function* () {
      const { forgotten, removed, requests } = yield* run([
        entryFor("owned", "account"),
        entryFor("paired", undefined),
        entryFor("owned-too", "account"),
      ]);
      expect(forgotten).toBe(2);
      expect(removed.toSorted()).toEqual(["owned", "owned-too"]);
      // Each session is ended with its own saved token before it is forgotten.
      expect(requests.toSorted((a, b) => a.url.localeCompare(b.url))).toEqual([
        {
          url: "https://owned-too.example.test/api/auth/logout",
          authorization: "Bearer token-bearer:owned-too",
        },
        {
          url: "https://owned.example.test/api/auth/logout",
          authorization: "Bearer token-bearer:owned",
        },
      ]);
    }),
  );

  it.effect("forgets a connection even when its machine cannot be reached", () =>
    Effect.gen(function* () {
      const { forgotten, removed } = yield* run(
        [entryFor("asleep", "account"), entryFor("awake", "account")],
        { unreachable: ["asleep"] },
      );
      expect(forgotten).toBe(2);
      expect(removed.toSorted()).toEqual(["asleep", "awake"]);
    }),
  );

  it.effect("does nothing when no connection was opened with the account", () =>
    Effect.gen(function* () {
      const { forgotten, removed, requests } = yield* run([entryFor("paired", undefined)]);
      expect(forgotten).toBe(0);
      expect(removed).toEqual([]);
      expect(requests).toEqual([]);
    }),
  );
});
