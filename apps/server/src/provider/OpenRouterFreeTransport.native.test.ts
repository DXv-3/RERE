import * as FreeRequestStore from "./FreeRequestStore.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import { it } from "@effect/vitest";
// Opt-in local Codex fixture: the upstream is synthetic and no inference is sent.
import { expect, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CodexSettings, ProviderInstanceId, ThreadId, ProviderSessionId } from "@t3tools/contracts";
import * as Adapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "../orchestration-v2/ProviderAdapter.ts";
import * as Loggers from "./Layers/ProviderEventLoggers.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Transport from "./OpenRouterFreeTransport.ts";
const decodeSettings = Schema.decodeEffect(CodexSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const route = { model: "test/model:free", endpoint: "test/provider" };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

it.live.skipIf(!process.env.WORKBENCH_TEST_CODEX_BINARY)(
  "runs a real Codex tool loop through the guarded launch transport",
  () =>
    Effect.gen(function* () {
      const requests: Record<string, unknown>[] = [];
      const command = "printf WORKBENCH_SYNTHETIC_TOOL_OK";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          const body: unknown = JSON.parse(String(init.body));
          if (!record(body)) throw Error("Expected request object");
          requests.push(body);
          if (requests.length > 2) throw Error("Unexpected extra model request");
          const tools = Array.isArray(body.tools) ? body.tools.filter(record) : [];
          const shell =
            tools.find((tool) => tool.name === "exec_command") ??
            tools.find((tool) => tool.name === "shell");
          if (!shell)
            throw Error(`Fixture shell tool missing: ${tools.map((tool) => tool.name).join(",")}`);
          const item =
            requests.length === 1
              ? {
                  type: "function_call",
                  id: "fc_fixture",
                  call_id: "call_fixture",
                  name: shell.name,
                  arguments: JSON.stringify(
                    shell.name === "exec_command"
                      ? { cmd: command, max_output_tokens: 100 }
                      : { command: ["/bin/sh", "-c", command] },
                  ),
                  status: "completed",
                }
              : {
                  type: "message",
                  id: "msg_fixture",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Synthetic verification complete.",
                      annotations: [],
                    },
                  ],
                  status: "completed",
                };
          const response = {
            id: `resp_fixture_${requests.length}`,
            object: "response",
            model: route.model,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost: 0 },
          };
          const events = [
            {
              type: "response.created",
              response: { ...response, status: "in_progress", output: [] },
            },
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ];
          return new Response(
            events
              .map(
                (event, index) =>
                  `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-free-native-" });
            const factory = yield* Adapter.CodexAppServerClientFactory;
            const client = yield* factory.open({
              instanceId: ProviderInstanceId.make("synthetic-guarded"),
              threadId: ThreadId.make("synthetic-thread"),
              providerSessionId: ProviderSessionId.make("synthetic-session"),
              runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: home,
              }),
              settings: yield* decodeSettings({
                binaryPath: process.env.WORKBENCH_TEST_CODEX_BINARY,
                homePath: home,
                openRouterFree: route,
                launchArgs: '-c web_search="disabled" -c features.unified_exec=true',
              }),
              environment: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
            });
            yield* client.request("initialize", {
              clientInfo: { name: "workbench_guard_fixture", version: "1" },
              capabilities: { experimentalApi: true },
            });
            yield* client.notify("initialized", undefined);
            const done = yield* Deferred.make<unknown>();
            yield* client
              .handleServerNotification("turn/completed", (result) =>
                Deferred.succeed(done, result),
              )
              .pipe(Effect.forkScoped);
            const thread = yield* client.request("thread/start", {
              model: route.model,
              cwd: home,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
            });
            yield* client.request("turn/start", {
              threadId: thread.thread.id,
              input: [
                { type: "text", text: "Run the synthetic fixture command.", text_elements: [] },
              ],
            });
            const terminal = yield* Deferred.await(done);
            expect(terminal, encodeJson(terminal)).toMatchObject({
              turn: { status: "completed" },
            });
            expect(requests).toHaveLength(2);
            const items = requests[1]?.input;
            expect(
              Array.isArray(items) &&
                items
                  .filter(record)
                  .some(
                    (item) =>
                      item.type === "function_call_output" &&
                      String(item.output).includes("WORKBENCH_SYNTHETIC_TOOL_OK"),
                  ),
            ).toBe(true);
            for (const request of requests)
              expect(request.provider).toMatchObject({
                max_price: { prompt: 0, completion: 0, request: 0 },
                allow_fallbacks: false,
              });
          }),
        ).pipe(
          Effect.timeout("40 seconds"),
          Effect.provide(
            Adapter.codexAppServerClientFactoryFromSettingsLayer.pipe(
              Layer.provide(
                Transport.layer.pipe(
                  Layer.provide(
                    FreeRequestStore.layer.pipe(Layer.provide(Sqlite.SqlitePersistenceMemory)),
                  ),
                ),
              ),
              Layer.provide(
                Layer.mock(SecretStore.ServerSecretStore)({
                  get: () => Effect.succeed(Option.some(new TextEncoder().encode("fixture-key"))),
                }),
              ),
              Layer.provide(
                Layer.succeed(Loggers.ProviderEventLoggers, Loggers.NoOpProviderEventLoggers),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }),
  50_000,
);
