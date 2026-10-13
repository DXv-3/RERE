import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthAccountAccessTokenType,
  AuthAdministrativeScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import type { AccountSignInMode } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { computeDpopJwkThumbprint, type DpopPublicJwk } from "@t3tools/shared/dpop";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AccountSignIn from "./AccountSignIn.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const ISSUER = "https://login.example.test/realms/codewrench";
const AUDIENCE = "codewrench-relay";
const OWNER = "owner-user-id";

/** A local key pair stands in for the account provider. */
const provider = await (async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  const stranger = await generateKeyPair("RS256");
  const sign = (
    input: {
      sub?: string | null;
      iss?: string;
      aud?: string;
      typ?: string;
      expiresIn?: string | number;
      signWith?: "provider" | "stranger";
    } = {},
  ) => {
    const builder = new SignJWT({ typ: input.typ ?? "Bearer" })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(input.iss ?? ISSUER)
      .setAudience(input.aud ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(input.expiresIn ?? "5m");
    if (input.sub !== null) builder.setSubject(input.sub ?? OWNER);
    return builder.sign(input.signWith === "stranger" ? stranger.privateKey : privateKey);
  };
  return { keys: createLocalJWKSet({ keys: [jwk] }), sign };
})();

function makeEnvironment(
  input: {
    mode?: AccountSignInMode;
    linkedUserId?: string | null;
    configured?: boolean;
  } = {},
) {
  const store = new Map<string, Uint8Array>();
  if (input.linkedUserId !== null) {
    store.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode(input.linkedUserId ?? OWNER));
  }
  const secretStore = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      return ServerSecretStore.ServerSecretStore.of({
        get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
        set: (name, value) => Effect.sync(() => void store.set(name, value)),
        create: (name, value) => Effect.sync(() => void store.set(name, value)),
        getOrCreateRandom: (name, bytes) =>
          Effect.gen(function* () {
            const existing = store.get(name);
            if (existing) return existing;
            const random = yield* crypto.randomBytes(bytes);
            store.set(name, random);
            return random;
          }).pipe(Effect.orDie),
        remove: (name) => Effect.sync(() => void store.delete(name)),
      });
    }),
  );
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-session-" });
  const settingsLayer = ServerSettings.layerTest({ accountSignIn: input.mode ?? "allowed" });
  const environmentAuthLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(secretStore),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provide(configLayer),
  );
  const accountLayer = Layer.effect(
    AccountSignIn.AccountSignIn,
    AccountSignIn.make({
      oidc: Effect.succeed(
        input.configured === false
          ? Option.none()
          : Option.some({ oidcIssuer: ISSUER, oidcAudience: AUDIENCE }),
      ),
      keys: provider.keys,
    }),
  ).pipe(
    Layer.provide(settingsLayer),
    Layer.provide(secretStore),
    Layer.provideMerge(environmentAuthLayer),
  );
  const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(authHttpApiLayer),
    Layer.provide(environmentAuthenticatedAuthLayer),
    Layer.provideMerge(accountLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { routesLayer, accountLayer };
}

/** Runs `use` against a fresh in-memory environment, with the same service instances the routes use. */
const withEnvironment = <A>(
  options: Parameters<typeof makeEnvironment>[0],
  use: (env: {
    readonly fetch: (request: Request) => Promise<Response>;
    /** A pairing credential issued by the same environment, for comparing with account sign-in. */
    readonly pairingCredential: string;
    readonly nowSeconds: number;
  }) => Promise<A>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const { routesLayer, accountLayer } = makeEnvironment(options);
    const memoMap = Layer.makeMemoMapUnsafe();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithMemoMap(accountLayer, memoMap, scope);
    const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
    const pairingCredential = (yield* auth.issuePairingCredential()).credential;
    const nowSeconds = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const web = HttpRouter.toWebHandler(routesLayer, { disableLogger: true, memoMap });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      // These routes read secrets through the layer, not the request context.
      Context.add(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeedNone,
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.die("Not used by these routes."),
          remove: () => Effect.void,
        }),
      ),
    );
    return yield* Effect.tryPromise(() =>
      use({
        fetch: (request) => web.handler(request, requestContext),
        pairingCredential,
        nowSeconds,
      }),
    ).pipe(
      Effect.ensuring(Effect.promise(() => web.dispose())),
      Effect.ensuring(Scope.close(scope, { _tag: "Success", value: undefined } as never)),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const post = (path: string, headers: Record<string, string> = {}, body?: string) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", headers, ...(body ? { body } : {}) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const exchange = (token: string) => post("/api/auth/account-session", bearer(token));

/** The attributes of a Set-Cookie header with the name, value and expiry removed. */
const cookieAttributes = (setCookie: string) =>
  setCookie
    .split(";")
    .slice(1)
    .map((part) => part.trim())
    .filter((part) => !part.toLowerCase().startsWith("expires="))
    .toSorted();
const cookiePair = (setCookie: string) => setCookie.split(";", 1)[0] ?? "";

it.live("lets the linked owner in with the pairing cookie and the owner's full scopes", () =>
  withEnvironment({}, async ({ fetch, pairingCredential }) => {
    const response = await fetch(exchange(await provider.sign()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { scopes: string[]; sessionMethod: string };
    expect(body.sessionMethod).toBe("browser-session-cookie");
    expect(new Set(body.scopes)).toEqual(new Set(AuthAdministrativeScopes));
    const accountCookies = response.headers.getSetCookie();
    expect(accountCookies).toHaveLength(1);

    const paired = await fetch(
      post(
        "/api/auth/browser-session",
        { "content-type": "application/json" },
        JSON.stringify({ credential: pairingCredential }),
      ),
    );
    expect(paired.status).toBe(200);
    const pairedCookie = paired.headers.getSetCookie()[0] ?? "";
    const accountCookie = accountCookies[0] ?? "";
    expect(accountCookie.split("=", 1)[0]).toBe(pairedCookie.split("=", 1)[0]);
    expect(cookieAttributes(accountCookie)).toEqual(cookieAttributes(pairedCookie));
    expect(cookieAttributes(accountCookie)).toContain("HttpOnly");

    const state = await fetch(
      new Request("http://127.0.0.1/api/auth/session", {
        headers: { cookie: cookiePair(accountCookie) },
      }),
    );
    expect(await state.json()).toMatchObject({ authenticated: true, accountSignIn: "allowed" });
  }),
);

it.live("turns away an account that is not the linked one, saying nothing else", () =>
  withEnvironment({}, async ({ fetch }) => {
    const response = await fetch(exchange(await provider.sign({ sub: "someone-else" })));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      _tag: "EnvironmentAccountNotOwnerError",
      code: "account_not_owner",
      traceId: expect.any(String),
    });
    expect(text).not.toContain(OWNER);
    // A sub that only starts with the owner's is a different account.
    expect((await fetch(exchange(await provider.sign({ sub: `${OWNER}-2` })))).status).toBe(403);
    expect((await fetch(exchange(await provider.sign({ sub: OWNER.slice(0, -1) })))).status).toBe(
      403,
    );
  }),
);

it.live("refuses tokens that fail verification before comparing accounts", () =>
  withEnvironment({}, async ({ fetch }) => {
    const refused = [
      await provider.sign({ expiresIn: -120 }),
      await provider.sign({ iss: "https://login.example.test/realms/other" }),
      await provider.sign({ aud: "some-other-app" }),
      await provider.sign({ signWith: "stranger" }),
      await provider.sign({ typ: "ID" }),
      await provider.sign({ sub: null }),
      "not-a-jwt",
      "a.b.c",
      "",
    ];
    for (const token of refused) {
      const response = await fetch(exchange(token));
      expect([401]).toContain(response.status);
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  }),
);

// An account access token is a bearer credential the provider issued for a few minutes, not a
// one-time login ticket: the web gate retries with the same token, and a client may open several
// browsers or environments with one. Reuse is allowed; what stays closed is an expired token and
// a session that was signed out.
it.live("accepts the same valid token again, each time as a fresh session", () =>
  withEnvironment({}, async ({ fetch }) => {
    const token = await provider.sign();
    const first = await fetch(exchange(token));
    const second = await fetch(exchange(token));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCookie = cookiePair(first.headers.getSetCookie()[0] ?? "");
    const secondCookie = cookiePair(second.headers.getSetCookie()[0] ?? "");
    expect(firstCookie).not.toBe(secondCookie);

    // Signing one session out leaves the other, and the token still opens a third.
    const loggedOut = await fetch(post("/api/auth/logout", { cookie: firstCookie }));
    expect(await loggedOut.json()).toEqual({ signedOut: true });
    const stillIn = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie: secondCookie } }),
    );
    expect(await stillIn.json()).toMatchObject({ authenticated: true });
    expect((await fetch(exchange(token))).status).toBe(200);

    // The token endpoint takes the same token too, however often it was used above.
    const grants = await Promise.all([fetch(accountGrant(token)), fetch(accountGrant(token))]);
    expect(grants.map((grant) => grant.status)).toEqual([200, 200]);
    const [a, b] = (await Promise.all(grants.map((grant) => grant.json()))) as AccessTokenBody[];
    expect(a?.access_token).not.toBe(b?.access_token);
  }),
);

it.live("allows a few seconds of clock skew and no more", () =>
  withEnvironment({}, async ({ fetch, nowSeconds }) => {
    expect(
      (await fetch(exchange(await provider.sign({ expiresIn: nowSeconds - 10 })))).status,
    ).toBe(200);
    expect(
      (await fetch(exchange(await provider.sign({ expiresIn: nowSeconds - 60 })))).status,
    ).toBe(401);
  }),
);

it.live("takes the token only from the Authorization bearer header", () =>
  withEnvironment({}, async ({ fetch }) => {
    const token = await provider.sign();
    const inQuery = await fetch(post(`/api/auth/account-session?access_token=${token}`));
    expect(inQuery.status).toBe(401);
    const inBody = await fetch(
      post(
        "/api/auth/account-session",
        { "content-type": "application/json" },
        JSON.stringify({ token, access_token: token, credential: token }),
      ),
    );
    expect(inBody.status).toBe(401);
    const wrongScheme = await fetch(
      post("/api/auth/account-session", { authorization: `Basic ${token}` }),
    );
    expect(wrongScheme.status).toBe(401);
    const extraParts = await fetch(
      post("/api/auth/account-session", { authorization: `Bearer ${token} ${token}` }),
    );
    expect(extraParts.status).toBe(401);
    expect((await fetch(post("/api/auth/account-session"))).status).toBe(401);
    expect(
      (await fetch(post("/api/auth/account-session", { authorization: `bearer ${token}` }))).status,
    ).toBe(200);
  }),
);

it.live("is unavailable when the setting is off, no owner is linked or the provider is unset", () =>
  Effect.gen(function* () {
    const token = yield* Effect.promise(() => provider.sign());
    for (const options of [
      { mode: "off" as const },
      { linkedUserId: null },
      { linkedUserId: "" },
      { configured: false },
    ]) {
      yield* withEnvironment(options, async ({ fetch }) => {
        const response = await fetch(exchange(token));
        expect(response.status).toBe(404);
        expect(JSON.parse(await response.text())).toEqual({
          _tag: "EnvironmentAccountSignInUnavailableError",
          code: "account_sign_in_unavailable",
          traceId: expect.any(String),
        });
        expect(response.headers.getSetCookie()).toHaveLength(0);
        const state = await fetch(new Request("http://127.0.0.1/api/auth/session"));
        expect(await state.json()).not.toHaveProperty("accountSignIn");
      });
    }
  }),
);

it.live("reports required mode to a visitor who has no session", () =>
  withEnvironment({ mode: "required" }, async ({ fetch }) => {
    const state = await fetch(new Request("http://127.0.0.1/api/auth/session"));
    const body = (await state.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ authenticated: false, accountSignIn: "required" });
    expect(JSON.stringify(body)).not.toContain(OWNER);
  }),
);

it.live("slows repeated attempts", () =>
  withEnvironment({}, async ({ fetch }) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      statuses.push((await fetch(exchange("garbage"))).status);
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
  }),
);

it.live("logout ends an account sign-in session and only that", () =>
  withEnvironment({}, async ({ fetch, pairingCredential }) => {
    const signedIn = await fetch(exchange(await provider.sign()));
    const accountCookie = cookiePair(signedIn.headers.getSetCookie()[0] ?? "");
    const loggedOut = await fetch(post("/api/auth/logout", { cookie: accountCookie }));
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.json()).toEqual({ signedOut: true });
    expect(loggedOut.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
    );
    const after = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie: accountCookie } }),
    );
    expect(await after.json()).toMatchObject({ authenticated: false });

    // A browser paired by code keeps its session.
    const paired = await fetch(
      post(
        "/api/auth/browser-session",
        { "content-type": "application/json" },
        JSON.stringify({ credential: pairingCredential }),
      ),
    );
    const pairedCookie = cookiePair(paired.headers.getSetCookie()[0] ?? "");
    const ignored = await fetch(post("/api/auth/logout", { cookie: pairedCookie }));
    expect(await ignored.json()).toEqual({ signedOut: false });
    expect(ignored.headers.getSetCookie()).toHaveLength(0);
    const still = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie: pairedCookie } }),
    );
    expect(await still.json()).toMatchObject({ authenticated: true });

    // No session at all is a quiet success.
    const nobody = await fetch(post("/api/auth/logout"));
    expect(await nobody.json()).toEqual({ signedOut: false });
  }),
);

it.live("logout ends an account bearer session and leaves a paired bearer session alone", () =>
  withEnvironment({}, async ({ fetch, pairingCredential }) => {
    const grant = (await (await fetch(accountGrant(await provider.sign()))).json()) as {
      access_token: string;
    };
    const loggedOut = await fetch(post("/api/auth/logout", bearer(grant.access_token)));
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.json()).toEqual({ signedOut: true });
    // There is no cookie for a bearer client to clear.
    expect(loggedOut.headers.getSetCookie()).toHaveLength(0);
    const after = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: bearer(grant.access_token) }),
    );
    expect(await after.json()).toMatchObject({ authenticated: false });

    const paired = (await (await fetch(pairingGrant(pairingCredential))).json()) as {
      access_token: string;
    };
    const ignored = await fetch(post("/api/auth/logout", bearer(paired.access_token)));
    expect(await ignored.json()).toEqual({ signedOut: false });
    const still = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: bearer(paired.access_token) }),
    );
    expect(await still.json()).toMatchObject({ authenticated: true });
  }),
);

// Remote clients (desktop, phone) trade the account access token for a bearer token at /oauth/token.

const tokenRequest = (
  fields: Record<string, string>,
  headers: Record<string, string> = {},
  path = "/oauth/token",
) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const accountGrant = (token: string, extra: Record<string, string> = {}) =>
  tokenRequest({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: token,
    subject_token_type: AuthAccountAccessTokenType,
    requested_token_type: AuthAccessTokenType,
    ...extra,
  });
const pairingGrant = (credential: string) =>
  tokenRequest({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: credential,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
  });

type AccessTokenBody = {
  access_token: string;
  issued_token_type: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

const dpopKey = (() => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
})();
const dpopProof = (input: { url: string; iat: number; jti: string; method?: string }) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: dpopKey.jwk });
  const payload = encode({
    htm: input.method ?? "POST",
    htu: input.url,
    jti: input.jti,
    iat: input.iat,
  });
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: dpopKey.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

it.live("the account grant issues the same kind of session a pairing exchange issues", () =>
  withEnvironment({}, async ({ fetch, pairingCredential }) => {
    const paired = await fetch(pairingGrant(pairingCredential));
    expect(paired.status).toBe(200);
    const pairedBody = (await paired.json()) as AccessTokenBody;

    const response = await fetch(accountGrant(await provider.sign()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toHaveLength(0);
    const body = (await response.json()) as AccessTokenBody;

    expect(Object.keys(body).toSorted()).toEqual(Object.keys(pairedBody).toSorted());
    expect(body.issued_token_type).toBe(pairedBody.issued_token_type);
    expect(body.token_type).toBe("Bearer");
    expect(body.token_type).toBe(pairedBody.token_type);
    // Same lifetime, give or take the seconds between the two requests.
    expect(Math.abs(body.expires_in - pairedBody.expires_in)).toBeLessThan(5);
    expect(body.expires_in).toBeGreaterThan(29 * 24 * 3600);
    // The owner gets the administrative scopes.
    expect(new Set(body.scope.split(" "))).toEqual(new Set(AuthAdministrativeScopes));
    expect(body.access_token).not.toBe(pairedBody.access_token);

    // The session is a bearer session the owner can use...
    const state = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: bearer(body.access_token) }),
    );
    expect(await state.json()).toMatchObject({
      authenticated: true,
      sessionMethod: "bearer-access-token",
    });

    // ...see, labelled as account sign-in, and revoke (from another session: a session cannot
    // revoke itself).
    const second = (await (
      await fetch(accountGrant(await provider.sign()))
    ).json()) as AccessTokenBody;
    const listed = (await (
      await fetch(
        new Request("http://127.0.0.1/api/auth/clients", { headers: bearer(second.access_token) }),
      )
    ).json()) as Array<{
      sessionId: string;
      method: string;
      subject: string;
      client: { label?: string };
      current: boolean;
    }>;
    expect(listed.filter((entry) => entry.subject === "account-sign-in")).toHaveLength(2);
    const other = listed.find((entry) => !entry.current && entry.subject === "account-sign-in");
    expect(other).toMatchObject({
      method: "bearer-access-token",
      client: { label: "Account sign-in" },
    });
    const revoked = await fetch(
      post(
        "/api/auth/clients/revoke",
        { ...bearer(second.access_token), "content-type": "application/json" },
        JSON.stringify({ sessionId: other?.sessionId }),
      ),
    );
    expect(await revoked.json()).toEqual({ revoked: true });
    const after = await fetch(
      new Request("http://127.0.0.1/api/auth/session", { headers: bearer(body.access_token) }),
    );
    expect(await after.json()).toMatchObject({ authenticated: false });
  }),
);

it.live("the account grant narrows scopes on request and refuses scopes the owner lacks", () =>
  withEnvironment({}, async ({ fetch }) => {
    const narrowed = await fetch(
      accountGrant(await provider.sign(), { scope: "orchestration:read" }),
    );
    expect(narrowed.status).toBe(200);
    expect(((await narrowed.json()) as AccessTokenBody).scope).toBe("orchestration:read");
    const invalid = await fetch(accountGrant(await provider.sign(), { scope: "made:up" }));
    expect(invalid.status).toBe(400);
  }),
);

it.live("the account grant turns away another account without naming this environment", () =>
  withEnvironment({}, async ({ fetch }) => {
    const response = await fetch(accountGrant(await provider.sign({ sub: "someone-else" })));
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      _tag: "EnvironmentAccountNotOwnerError",
      code: "account_not_owner",
      traceId: expect.any(String),
    });
    expect(text).not.toContain(OWNER);
    expect((await fetch(accountGrant(await provider.sign({ sub: `${OWNER}-2` })))).status).toBe(
      403,
    );
  }),
);

it.live("the account grant refuses tokens that fail verification", () =>
  withEnvironment({}, async ({ fetch }) => {
    const refused = [
      await provider.sign({ expiresIn: -120 }),
      await provider.sign({ iss: "https://login.example.test/realms/other" }),
      await provider.sign({ aud: "some-other-app" }),
      await provider.sign({ signWith: "stranger" }),
      await provider.sign({ typ: "ID" }),
      await provider.sign({ sub: null }),
      "not-a-jwt",
      "a.b.c",
    ];
    for (const token of refused) {
      const response = await fetch(accountGrant(token));
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("access_token");
    }
    // A pairing credential is not an account token, and an account token is not a pairing credential.
    expect(
      (
        await fetch(
          tokenRequest({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: await provider.sign(),
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
          }),
        )
      ).status,
    ).toBe(401);
    // The pairing form field is not read as a header or query token.
    expect((await fetch(post("/oauth/token", bearer(await provider.sign())))).status).not.toBe(200);
  }),
);

it.live(
  "the account grant is unavailable whenever account sign-in cannot work, whatever the reason",
  () =>
    Effect.gen(function* () {
      const token = yield* Effect.promise(() => provider.sign());
      const bodies: string[] = [];
      for (const options of [
        { mode: "off" as const },
        { linkedUserId: null },
        { linkedUserId: "" },
        { configured: false },
      ]) {
        yield* withEnvironment(options, async ({ fetch }) => {
          for (const request of [
            accountGrant(token),
            accountGrant("garbage"),
            accountGrant(token, { scope: "made:up" }),
          ]) {
            const response = await fetch(request);
            expect(response.status).toBe(404);
            const parsed = JSON.parse(await response.text()) as { traceId: string };
            bodies.push(JSON.stringify({ ...parsed, traceId: "" }));
            expect(parsed).toEqual({
              _tag: "EnvironmentAccountSignInUnavailableError",
              code: "account_sign_in_unavailable",
              traceId: expect.any(String),
            });
          }
        });
      }
      expect(new Set(bodies).size).toBe(1);
    }),
);

it.live("the account grant works in required mode too", () =>
  withEnvironment({ mode: "required" }, async ({ fetch }) => {
    expect((await fetch(accountGrant(await provider.sign()))).status).toBe(200);
  }),
);

it.live("the account grant shares the sign-in rate limit with the cookie path", () =>
  withEnvironment({}, async ({ fetch }) => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      statuses.push(
        (await fetch(attempt % 2 === 0 ? accountGrant("garbage") : exchange("garbage"))).status,
      );
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(20).every((status) => status === 429)).toBe(true);
    // The owner is held back too until the window passes.
    expect((await fetch(accountGrant(await provider.sign()))).status).toBe(429);
  }),
);

it.live(
  "the account grant binds the session to a DPoP key exactly as a pairing exchange does",
  () =>
    withEnvironment({}, async ({ fetch, nowSeconds }) => {
      // The request URL the server rebuilds from the in-memory request has no port or host header.
      const url = "http://localhost/oauth/token";
      const requestUrl = "http://127.0.0.1/oauth/token";
      const proof = dpopProof({ url, iat: nowSeconds, jti: "account-proof-1" });
      const response = await fetch(accountGrant(await provider.sign(), {}));
      expect(response.status).toBe(200);
      const bound = await fetch(
        new Request(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: proof,
          },
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: await provider.sign(),
            subject_token_type: AuthAccountAccessTokenType,
            requested_token_type: AuthAccessTokenType,
          }).toString(),
        }),
      );
      expect(bound.status).toBe(200);
      const body = (await bound.json()) as AccessTokenBody;
      expect(body.token_type).toBe("DPoP");
      expect(body.expires_in).toBeLessThanOrEqual(3600);
      expect(computeDpopJwkThumbprint(dpopKey.jwk)).toEqual(expect.any(String));

      // A proof that does not verify is refused, and the account token is not spent on it.
      const badProof = dpopProof({ url, iat: nowSeconds - 3600, jti: "account-proof-2" });
      const refused = await fetch(
        new Request(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            dpop: badProof,
          },
          body: new URLSearchParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: await provider.sign(),
            subject_token_type: AuthAccountAccessTokenType,
            requested_token_type: AuthAccessTokenType,
          }).toString(),
        }),
      );
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain("access_token");
    }),
);
