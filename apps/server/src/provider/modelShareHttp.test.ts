import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
  type ModelShare,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import { HttpRouter } from "effect/unstable/http";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { afterEach, expect, it } from "vite-plus/test";

import { modelSharesHttpApiLayer } from "./modelShareHttp.ts";
import * as ModelShares from "./ModelShares.ts";

class ModelSharesTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.modelShares,
) {}

const share: ModelShare = {
  id: "share-1",
  label: "Sam",
  providerInstanceId: "local",
  models: ["qwen38"],
  createdAt: "2026-10-06T00:00:00.000Z",
  lastUsedAt: null,
};

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const calls: Array<string> = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(ModelSharesTestApi).pipe(
      Layer.provide(modelSharesHttpApiLayer),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          effect.pipe(
            Effect.provideService(EnvironmentAuthenticatedPrincipal, {
              sessionId: AuthSessionId.make("session"),
              subject: "test",
              method: "browser-session-cookie",
              scopes: new Set(scopes),
            }),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeed(ModelShares.ModelShares, {
          list: Effect.sync(() => {
            calls.push("list");
            return [share];
          }),
          shareableProviders: Effect.succeed([
            { providerInstanceId: "local", displayName: "Local", models: ["qwen38"] },
          ]),
          create: (input: { readonly providerInstanceId: string }) => {
            calls.push(`create:${input.providerInstanceId}`);
            return input.providerInstanceId === "local"
              ? Effect.succeed({ share, token: "cwm_secret" })
              : Effect.fail(
                  new ModelShares.ModelShareRefusedError({ reason: "provider_uses_anthropic" }),
                );
          },
          revoke: (id: string) => {
            calls.push(`revoke:${id}`);
            return Effect.succeed(true);
          },
        } as unknown as ModelShares.ModelShares["Service"]),
      ),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const post = (path: string, body: unknown) =>
    handler(
      new Request(`http://t3.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { handler, post, calls };
};

it("keeps shares out of reach of an ordinary paired client", async () => {
  const { handler, post, calls } = fixture(AuthStandardClientScopes);

  expect((await handler(new Request("http://t3.test/api/model-shares"))).status).toBe(403);
  expect(
    (await post("/api/model-shares", { label: "Sam", providerInstanceId: "local" })).status,
  ).toBe(403);
  expect((await post("/api/model-shares/revoke", { id: "share-1" })).status).toBe(403);
  expect(calls).toEqual([]);
});

it("lets an administrator list, create and revoke shares", async () => {
  const { handler, post, calls } = fixture(AuthAdministrativeScopes);

  const snapshot = await handler(new Request("http://t3.test/api/model-shares"));
  expect(snapshot.status).toBe(200);
  const listed = await snapshot.text();
  expect(listed).toContain("qwen38");
  expect(listed).not.toContain("cwm_");

  const created = await post("/api/model-shares", { label: "Sam", providerInstanceId: "local" });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({ share: { id: "share-1" }, token: "cwm_secret" });

  const refused = await post("/api/model-shares", { label: "Sam", providerInstanceId: "claude" });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ reason: "provider_not_shareable" });

  const revoked = await post("/api/model-shares/revoke", { id: "share-1" });
  expect(await revoked.json()).toEqual({ revoked: true });
  expect(calls).toEqual(["list", "create:local", "create:claude", "revoke:share-1"]);
});
