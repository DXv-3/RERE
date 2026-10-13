// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { afterEach, expect, it } from "vite-plus/test";
import type { ModelShare } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";

import { modelShareProxyRouteLayer } from "./ModelShareProxy.ts";
import * as ModelShares from "./ModelShares.ts";

const TOKEN = "cwm_valid";
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

const fixture = (options: { readonly upstream?: "ok" | "down" | "gone" } = {}) => {
  const upstream = options.upstream ?? "ok";
  const requests: Array<{
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, headers: { ...request.headers }, body });
      if (upstream === "down") return yield* Effect.fail(new Error("connection refused") as never);
      return HttpClientResponse.fromWeb(
        request,
        new Response("event: message_start\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    modelShareProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(ModelShares.ModelShares, {
          authorize: (token: string) =>
            Effect.succeed(token === TOKEN ? Option.some(share) : Option.none()),
          resolveUpstream: () =>
            upstream === "gone"
              ? Effect.fail(
                  new ModelShares.ModelShareUpstreamUnavailableError({
                    providerInstanceId: "local",
                  }),
                )
              : Effect.succeed({
                  baseUrl: "http://gateway.test",
                  headers: { authorization: "Bearer gateway-key" },
                }),
        } as unknown as ModelShares.ModelShares["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests };
};

const messages = (token: string | null, body: unknown, path = "/v1/messages?beta=true") =>
  new Request(`http://t3.test/api/model-share${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      cookie: "t3_session=owner-cookie",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

it("forwards a message with the owner's gateway key and never the share token", async () => {
  const { handler, requests } = fixture();
  const response = await handler(messages(TOKEN, { model: "qwen38", stream: true }));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-transform");
  expect(await response.text()).toBe("event: message_start\n\n");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe("http://gateway.test/v1/messages?beta=true");
  expect(requests[0]!.headers.authorization).toBe("Bearer gateway-key");
  expect(requests[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  expect(requests[0]!.headers.cookie).toBeUndefined();
  expect(JSON.stringify(requests[0])).not.toContain(TOKEN);
  expect(JSON.parse(requests[0]!.body)).toEqual({ model: "qwen38", stream: true });
});

it("answers a model outside the share with the shared model", async () => {
  const { handler, requests } = fixture();
  const response = await handler(messages(TOKEN, { model: "claude-opus-5-5", max_tokens: 8 }));
  await response.text();
  expect(JSON.parse(requests[0]!.body)).toEqual({ model: "qwen38", max_tokens: 8 });
});

it.each([null, "cwm_wrong", "ABCDEFGHJKLM"])(
  "refuses token %s without calling the gateway",
  async (token) => {
    const { handler, requests } = fixture();
    const response = await handler(messages(token, { model: "qwen38" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { type: "authentication_error" } });
    expect(requests).toEqual([]);
  },
);

it("serves only the Anthropic routes a Claude client needs", async () => {
  const { handler, requests } = fixture();
  const get = (path: string) =>
    handler(
      new Request(`http://t3.test/api/model-share${path}`, { headers: { "x-api-key": TOKEN } }),
    );

  const models = await get("/v1/models");
  expect(models.status).toBe(200);
  expect(await models.json()).toMatchObject({ data: [{ id: "qwen38" }], has_more: false });

  expect((await get("/v1/messages")).status).toBe(404);
  expect((await get("/key/info")).status).toBe(404);
  expect((await handler(messages(TOKEN, { model: "qwen38" }, "/v1/files"))).status).toBe(404);
  expect((await handler(messages(TOKEN, { model: "qwen38" }, "/key/generate"))).status).toBe(404);
  expect(requests).toEqual([]);

  const count = await handler(messages(TOKEN, { model: "qwen38" }, "/v1/messages/count_tokens"));
  await count.text();
  expect(requests.map((request) => request.url)).toEqual([
    "http://gateway.test/v1/messages/count_tokens",
  ]);
});

it("reports a clear error when the shared provider is gone or not answering", async () => {
  const gone = await fixture({ upstream: "gone" }).handler(messages(TOKEN, { model: "qwen38" }));
  expect(gone.status).toBe(503);
  const down = await fixture({ upstream: "down" }).handler(messages(TOKEN, { model: "qwen38" }));
  expect(down.status).toBe(502);
  expect(JSON.stringify(await down.json())).not.toContain("gateway");
});

it("rejects a body that is not a JSON object", async () => {
  const { handler, requests } = fixture();
  const response = await handler(
    new Request("http://t3.test/api/model-share/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "nope",
    }),
  );
  expect(response.status).toBe(400);
  expect(requests).toEqual([]);
});

// A model share lends out this server's TEXT model and nothing else. The graphics card makes
// pictures and video for the owner's campaigns only, so no share route may reach it.
const PRODUCT_ROUTES = [
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/videos",
  "/v1/videos/generations",
  "/v1/chat/completions",
  "/v1/responses",
  "/api/campaigns/mutate",
  "/api/campaign-media/some-token/file.mp4",
  "/generation/start",
  "/v1/messages/../images/generations",
  "/v1/messages/%2e%2e/images/generations",
  "/v1/messages/",
  "/v1/models/extra",
];

it("exposes no route to image or video generation, whatever the method", async () => {
  const { handler, requests } = fixture();
  for (const path of PRODUCT_ROUTES) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const response = await handler(
        new Request(`http://t3.test/api/model-share${path}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          ...(method === "GET"
            ? {}
            : { body: JSON.stringify({ prompt: "a cake", kind: "video" }) }),
        }),
      );
      await response.text();
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  }
  // Not one of them reached the shared provider's endpoint.
  expect(requests).toEqual([]);
});

it("the share proxy does not import the campaign or generation code", () => {
  const source = NodeFS.readFileSync(new URL("./ModelShareProxy.ts", import.meta.url), "utf8");
  const imports = source
    .split("\n")
    .filter((line) => line.startsWith("import "))
    .join("\n");
  expect(imports).not.toMatch(/campaign|generation|LocalGpu/i);
});
