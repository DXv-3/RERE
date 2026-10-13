// @effect-diagnostics globalFetch:off globalFetchInEffect:off - real loopback HTTP acceptance with a fake upstream.
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FreeRequestStore from "./FreeRequestStore.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Transport from "./OpenRouterFreeTransport.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const localFetch = globalThis.fetch;
const route = { model: "test/model:free", endpoint: "test/provider" };
const body = {
  model: route.model,
  input: [{ role: "user", content: "Synthetic fixture" }],
  stream: false,
};
const key = "synthetic-key-never-forward-to-child";
const layer = Transport.layer.pipe(
  Layer.provide(FreeRequestStore.layer.pipe(Layer.provide(Sqlite.SqlitePersistenceMemory))),
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeed(Option.some(new TextEncoder().encode(key))),
    }),
  ),
);
const completed = (overrides: Record<string, unknown> = {}) => ({
  id: "receipt-fixture",
  model: route.model,
  status: "completed",
  usage: { cost: 0 },
  ...overrides,
});
const upstream = (value = completed()) => vi.fn(async () => Response.json(value));
const run = (
  test: (handle: {
    post: (value: unknown, path?: string, token?: string) => Promise<Response>;
    receipts: () => readonly unknown[];
    environment: NodeJS.ProcessEnv;
    args: readonly string[];
  }) => Promise<void>,
  testLayer: typeof layer = layer,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* Transport.OpenRouterFreeTransport;
      const handle = yield* service.open(route, {
        instanceId: "fixture",
        sessionId: "fixture-session",
      });
      const provider = handle.args.find((arg) => arg.startsWith("model_providers."))!;
      const origin = /base_url = "([^"]+)"/.exec(provider)![1];
      yield* Effect.promise(() =>
        test({
          ...handle,
          post: (
            value,
            path = "/responses",
            token = handle.environment.WORKBENCH_FREE_TRANSPORT_TOKEN!,
          ) =>
            localFetch(`${origin}${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: encodeJson(value),
            }),
        }),
      );
    }),
  ).pipe(Effect.provide(testLayer));
afterEach(() => vi.unstubAllGlobals());
it.live.each(["begin", "settle"] as const)("fails closed when durable %s fails", (phase) =>
  Effect.gen(function* () {
    const fetch = upstream();
    vi.stubGlobal("fetch", fetch);
    const store = Layer.succeed(FreeRequestStore.FreeRequestStore, {
      begin: () =>
        phase === "begin"
          ? Effect.fail(new FreeRequestStore.FreeRequestError({ reason: "storage" }))
          : Effect.succeed("fixture-owner"),
      settle: () => Effect.fail(new FreeRequestStore.FreeRequestError({ reason: "storage" })),
      read: () => Effect.succeed(null),
    });
    const testLayer = Transport.layer.pipe(
      Layer.provide(store),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode(key))),
        }),
      ),
    );
    yield* run(async ({ post }) => {
      let delivered = "";
      await post(body)
        .then(async (response) => {
          delivered = await response.text();
        })
        .catch(() => undefined);
      expect(delivered).not.toContain("receipt-fixture");
      expect(fetch).toHaveBeenCalledTimes(phase === "begin" ? 0 : 1);
    }, testLayer);
  }),
);
it.live(
  "guards every tool-loop request, binds exact model and keeps key outside child environment",
  () =>
    Effect.gen(function* () {
      const fetch = upstream();
      vi.stubGlobal("fetch", fetch);
      yield* run(async ({ post, receipts, environment, args }) => {
        expect(encodeJson(environment)).not.toContain(key);
        expect(args.join(" ")).toContain("request_max_retries = 0");
        expect((await post(body)).status).toBe(200);
        expect(
          (
            await post({
              ...body,
              input: [{ type: "function_call_output", call_id: "tool", output: "2" }],
            })
          ).status,
        ).toBe(200);
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const call of fetch.mock.calls as unknown as [string, RequestInit][]) {
          expect(call[0]).toBe("https://openrouter.ai/api/v1/responses");
          expect(call[1].redirect).toBe("error");
          const payload = JSON.parse(String(call[1].body));
          expect(payload.provider).toEqual({
            only: [route.endpoint],
            allow_fallbacks: false,
            require_parameters: true,
            max_price: { prompt: 0, completion: 0, request: 0 },
          });
          expect(payload.model).toBe(route.model);
        }
        expect(receipts()).toHaveLength(2);
        expect(receipts()[0]).toMatchObject({
          state: "completed_free",
          cost: 0,
          model: route.model,
        });
      });
    }),
);
it.live.each([
  { ...body, model: "paid/model" },
  { ...body, plugins: [{ id: "web" }] },
  { ...body, models: ["paid/model"] },
  { ...body, provider: { max_price: { prompt: 1 } } },
  { ...body, tools: [{ type: "web_search" }] },
  {
    ...body,
    input: [
      { role: "user", content: [{ type: "input_image", image_url: "https://example.test/x" }] },
    ],
  },
  { ...body, previous_response_id: "unbound-prior-response" },
])("rejects bypass or billable request before sending %#", (value) =>
  Effect.gen(function* () {
    const fetch = upstream();
    vi.stubGlobal("fetch", fetch);
    yield* run(async ({ post }) => {
      expect((await post(value)).status).toBe(400);
    });
    expect(fetch).not.toHaveBeenCalled();
  }),
);
it.live("does not send for an invalid token, unsupported path or replay", () =>
  Effect.gen(function* () {
    const fetch = upstream();
    vi.stubGlobal("fetch", fetch);
    yield* run(async ({ post }) => {
      expect((await post(body, "/responses", "wrong-token")).status).toBe(401);
      expect((await post(body, "/responses/compact")).status).toBe(404);
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(409);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);
it.live.each([
  completed({ usage: {} }),
  completed({ usage: { cost: 0.001 } }),
  completed({ model: "different/model:free" }),
  completed({ id: null }),
])("stops the connection after an unqualified completion %#", (result) =>
  Effect.gen(function* () {
    const fetch = upstream(result);
    vi.stubGlobal("fetch", fetch);
    yield* run(async ({ post, receipts }) => {
      await post(body)
        .then((response) => response.text())
        .catch(() => undefined);
      expect((await post({ ...body, instructions: "next" })).status).toBe(409);
      expect(receipts()[0]).toMatchObject({ state: "uncertain" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);
it.live("retains unknown cost after 429 and never retries or falls back", () =>
  Effect.gen(function* () {
    const fetch = vi.fn(async () => new Response("private upstream body", { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    yield* run(async ({ post, receipts }) => {
      const result = await post(body);
      expect(result.status).toBe(502);
      expect(await result.text()).not.toContain("private upstream");
      expect((await post({ ...body, instructions: "retry" })).status).toBe(409);
      expect(receipts()[0]).toMatchObject({ cost: null, state: "uncertain" });
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);
it.live("reads SSE receipts across chunk boundaries while forwarding bytes", () =>
  Effect.gen(function* () {
    const data = `event: response.completed\r\ndata: ${encodeJson({ type: "response.completed", response: completed() })}\r\n\r\ndata: [DONE]\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoded = new TextEncoder().encode(data);
                for (let index = 0; index < encoded.length; index += 7)
                  controller.enqueue(encoded.slice(index, index + 7));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    yield* run(async ({ post, receipts }) => {
      expect(await (await post({ ...body, stream: true })).text()).toBe(data);
      expect(receipts()[0]).toMatchObject({ cost: 0, state: "completed_free" });
    });
  }),
);
it.live("marks truncated streams uncertain and stops subsequent requests", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('data: {"type":"response.created"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    yield* run(async ({ post, receipts }) => {
      await post({ ...body, stream: true })
        .then((response) => response.text())
        .catch(() => undefined);
      expect(receipts()[0]).toMatchObject({ state: "uncertain" });
      expect((await post(body)).status).toBe(409);
    });
  }),
);

it.live("does not erase uncertainty when a stream fails after a completion receipt", () => {
  const events = [
    { type: "response.completed", response: completed() },
    { type: "response.failed" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    ),
  );
  return run(async ({ post, receipts }) => {
    await post({ ...body, stream: true })
      .then((response) => response.text())
      .catch(() => undefined);
    expect(receipts()[0]).toMatchObject({ state: "uncertain", cost: 0 });
    expect((await post(body)).status).toBe(409);
  });
});

it.live("refuses a missing dedicated credential before opening a connection", () =>
  Effect.gen(function* () {
    const transport = yield* Transport.OpenRouterFreeTransport;
    const result = yield* transport
      .open(route, { instanceId: "fixture", sessionId: "fixture-session" })
      .pipe(Effect.flip);
    expect(result.reason).toBe("not_configured");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Transport.layer.pipe(
        Layer.provide(FreeRequestStore.layer.pipe(Layer.provide(Sqlite.SqlitePersistenceMemory))),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    ),
  ),
);

it.live("keeps an uncertain live transport request blocked after reopening both services", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-transport-reopen-" });
    const persistence = Sqlite.makeSqlitePersistenceLive(`${directory}/state.sqlite`);
    const persisted = Transport.layer.pipe(
      Layer.provide(FreeRequestStore.layer),
      Layer.provide(persistence),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode(key))),
        }),
      ),
    );
    const fetch = vi.fn(
      async () =>
        new Response(
          '{"error":{"message":"No endpoints found that support the requested parameters. PRIVATE-ECHO"}}',
          { status: 404 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const attempt = (sessionId: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Transport.OpenRouterFreeTransport;
          const handle = yield* service.open(route, { instanceId: "fixture", sessionId });
          const provider = handle.args.find((arg) => arg.startsWith("model_providers."))!;
          const origin = /base_url = "([^"]+)"/.exec(provider)![1];
          const result = yield* Effect.promise(async () => {
            const response = await localFetch(`${origin}/responses`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${handle.environment.WORKBENCH_FREE_TRANSPORT_TOKEN}`,
                "content-type": "application/json",
              },
              body: encodeJson(body),
            });
            return { status: response.status, text: await response.text() };
          });
          expect(result.text).not.toContain("PRIVATE-ECHO");
          return result.status;
        }).pipe(Effect.provide(persisted)),
      );
    expect(yield* attempt("before-restart")).toBe(502);
    expect(yield* attempt("after-restart")).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
