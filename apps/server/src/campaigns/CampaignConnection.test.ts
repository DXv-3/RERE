import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { describe, expect, it as plainIt } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CampaignConnection from "./CampaignConnection.ts";

const seen: string[] = [];

const makeLayer = (values: Map<string, Uint8Array>) =>
  CampaignConnection.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
          set: (name, value) => Effect.sync(() => void values.set(name, value)),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
          remove: (name) => Effect.sync(() => void values.delete(name)),
        }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          seen.push(`${request.method} ${request.url} ${request.headers["x-api-key"] ?? ""}`);
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
        }),
      ),
    ),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(NodeServices.layer),
  );

describe("normalizeEngineBaseUrl", () => {
  plainIt("keeps a plain web address and drops the trailing slash", () => {
    expect(CampaignConnection.normalizeEngineBaseUrl(" https://engine.test/ ")).toBe(
      "https://engine.test",
    );
    expect(CampaignConnection.normalizeEngineBaseUrl("")).toBe("");
  });
  plainIt("refuses anything with a login, a query or another scheme", () => {
    for (const bad of [
      "ftp://x.test",
      "https://user:pw@x.test",
      "https://x.test?k=1",
      "nonsense",
    ]) {
      expect(CampaignConnection.normalizeEngineBaseUrl(bad)).toBeNull();
    }
  });
});

it.effect("stores the key as a secret, never returns it, and switches the connector", () => {
  const values = new Map<string, Uint8Array>();
  return Effect.gen(function* () {
    const connection = yield* CampaignConnection.CampaignConnection;
    const initial = yield* connection.get;
    assert.deepStrictEqual(initial, {
      connector: "export",
      baseUrl: "",
      hasKey: false,
      publishing: "off",
      exportDirectory: "",
    });
    assert.isFalse(yield* connection.publishingOn);
    assert.strictEqual((yield* connection.active).kind, "export");

    const state = yield* connection.set({
      connector: "marketing-engine",
      baseUrl: "https://engine.test/",
      apiKey: Redacted.make("secret-key-1"),
    });
    assert.deepStrictEqual(state, {
      connector: "marketing-engine",
      baseUrl: "https://engine.test",
      hasKey: true,
      publishing: "off",
      exportDirectory: "",
    });
    assert.isFalse(Object.values(state).includes("secret-key-1"));
    assert.strictEqual(
      new TextDecoder().decode(values.get(CampaignConnection.CAMPAIGN_ENGINE_KEY_SECRET)),
      "secret-key-1",
    );
    assert.strictEqual((yield* connection.active).kind, "marketing-engine");

    // The engine is tried with the stored key.
    assert.deepStrictEqual(yield* connection.test(), { ok: true });
    assert.deepStrictEqual(seen.at(-1), "GET https://engine.test/health secret-key-1");

    const cleared = yield* connection.set({ apiKey: null });
    assert.isFalse(cleared.hasKey);
    assert.isFalse(values.has(CampaignConnection.CAMPAIGN_ENGINE_KEY_SECRET));
    const refused = yield* connection.test();
    assert.isFalse(refused.ok);
  }).pipe(Effect.provide(makeLayer(values)));
});

it.effect("refuses an address or key that cannot be used and changes nothing", () => {
  const values = new Map<string, Uint8Array>();
  return Effect.gen(function* () {
    const connection = yield* CampaignConnection.CampaignConnection;
    const badUrl = yield* Effect.flip(connection.set({ baseUrl: "https://u:p@engine.test" }));
    assert.strictEqual(badUrl.reason, "invalid");
    const badKey = yield* Effect.flip(connection.set({ apiKey: Redacted.make("has a space") }));
    assert.strictEqual(badKey.reason, "invalid");
    assert.isFalse(values.has(CampaignConnection.CAMPAIGN_ENGINE_KEY_SECRET));
    assert.strictEqual((yield* connection.get).baseUrl, "");
  }).pipe(Effect.provide(makeLayer(values)));
});
