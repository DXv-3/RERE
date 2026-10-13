import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentSecretError,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as AgentSecrets from "../../../agents/AgentSecrets.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-secret-typing");
const agentThread = ThreadId.make("thread-agent");
const strangerThread = ThreadId.make("thread-stranger");
const tabId = PreviewTabId.make("tab-secret");
/** Distinctive on purpose: every check below searches for it. */
const VALUE = "ghp_needleNeedle0042";

const scopeFor = (threadId: ThreadId) => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-secret",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** The real browser toolkit, with only the secret store's reads stubbed. */
const brokenThread = ThreadId.make("thread-broken");
const secretsLayer = Layer.mock(AgentSecrets.AgentSecrets)({
  agentForThread: (threadId) =>
    threadId === agentThread || threadId === brokenThread
      ? Effect.succeed({ agentId: "agent-a", archived: false })
      : Effect.fail(new AgentSecretError({ reason: "not_an_agent_thread" })),
  valuesForThread: (threadId) =>
    threadId === brokenThread
      ? Effect.fail(new AgentSecretError({ reason: "storage" }))
      : Effect.succeed(threadId === agentThread ? [Redacted.make(VALUE)] : []),
  useForTyping: ({ agentId, name }) =>
    agentId === "agent-a" && name === "GITHUB_TOKEN"
      ? Effect.succeed({ value: Redacted.make(VALUE), allowedOrigins: [] })
      : agentId === "agent-a" && name === "LIMITED_TOKEN"
        ? Effect.succeed({
            value: Redacted.make(VALUE),
            allowedOrigins: ["https://app.example.test"],
          })
        : Effect.fail(new AgentSecretError({ reason: "secret_not_found" })),
});

const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(secretsLayer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-typing-" })),
  Layer.provideMerge(NodeServices.layer),
);

interface HostRequest {
  readonly operation: string;
  readonly input: unknown;
}

/**
 * A browser host that records what it is asked and answers `type` with an echo of the text, the
 * worst a misbehaving host could do, so the tool result is what has to keep the value out.
 */
const serveHost = (clientId: string, answer?: (operation: string) => unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const requests = yield* Ref.make<ReadonlyArray<HostRequest>>([]);
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      const { operation, input } = event.request;
      return Ref.update(requests, (all) => [...all, { operation, input }]).pipe(
        Effect.andThen(
          broker.respond({
            clientId,
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result:
              answer?.(operation) ??
              (operation === "type"
                ? { tabId, typed: (input as { text?: string }).text }
                : { tabId, available: true, url: "https://example.test/" }),
          }),
        ),
      );
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return requests;
  });

const callType = (threadId: ThreadId, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_type", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const show = (value: unknown): string => JSON.stringify(value);
const serialized = (result: McpSchema.CallToolResult) =>
  show([result.structuredContent, result.content]);

it.effect("secretName types the value into the browser without echoing it back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost("secret-typing-host");
      const args = {
        secretName: "GITHUB_TOKEN",
        locator: "role=textbox[name='Token']",
        clear: true,
      };
      // What the provider records for the call is exactly the arguments the model sent.
      expect(show(args)).not.toContain(VALUE);

      const result = yield* callType(agentThread, args);

      expect(result.isError).toBe(false);
      const typed = (yield* Ref.get(requests)).find((request) => request.operation === "type");
      // The browser host is the one place that receives the value.
      expect(typed?.input).toMatchObject({
        text: VALUE,
        locator: "role=textbox[name='Token']",
        clear: true,
      });
      expect(typed?.input).not.toHaveProperty("secretName");
      // Neither the result nor anything it embeds carries the value, even though the host echoed it.
      expect(serialized(result)).not.toContain(VALUE);
      expect(serialized(result)).not.toContain("needle");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("literal text typing is unchanged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost("literal-typing-host");
      const result = yield* callType(agentThread, { text: "hello", locator: "role=textbox" });
      expect(result.isError).toBe(false);
      const typed = (yield* Ref.get(requests)).find((request) => request.operation === "type");
      expect(typed?.input).toMatchObject({ text: "hello" });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses secretName outside an agent's thread and for another agent's secret", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost("secret-refusal-host");

      const stranger = yield* callType(strangerThread, { secretName: "GITHUB_TOKEN" });
      expect(stranger.isError).toBe(true);
      expect(serialized(stranger)).toContain("belongs to an agent");
      expect(serialized(stranger)).not.toContain(VALUE);

      const missing = yield* callType(agentThread, { secretName: "NOT_MINE" });
      expect(missing.isError).toBe(true);
      expect(serialized(missing)).toContain("no secret with that name");
      expect(serialized(missing)).not.toContain(VALUE);

      // Neither call reached the browser.
      expect((yield* Ref.get(requests)).filter((request) => request.operation === "type")).toEqual(
        [],
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("exactly one of text and secretName is required", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveHost("secret-schema-host");
      // A call that breaks the schema is refused before any handler runs.
      const neither = yield* Effect.result(callType(agentThread, { locator: "role=textbox" }));
      expect(neither._tag).toBe("Failure");
      expect(String(neither._tag === "Failure" ? neither.failure.message : "")).toContain(
        "Provide exactly one of text or secretName",
      );
      const both = yield* Effect.result(
        callType(agentThread, { text: "x", secretName: "GITHUB_TOKEN" }),
      );
      expect(both._tag).toBe("Failure");
      const badName = yield* Effect.result(callType(agentThread, { secretName: "lower_case" }));
      expect(badName._tag).toBe("Failure");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const callTool = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("snapshots and evaluated values come back with the agent's secrets masked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveHost("secret-masking-host", (operation) =>
        operation === "snapshot"
          ? {
              url: `https://example.test/?token=${VALUE}`,
              title: `Settings ${VALUE}`,
              loading: false,
              visibleText: `Your token is ${VALUE}`,
              interactiveElements: [],
              accessibilityTree: {},
              consoleEntries: [],
              networkEntries: [],
              actionTimeline: [],
              screenshot: {
                mimeType: "image/png",
                data: Buffer.from("png").toString("base64"),
                width: 1,
                height: 1,
              },
            }
          : operation === "evaluate"
            ? { echoed: VALUE, list: [`a ${VALUE} b`] }
            : undefined,
      );

      const snapshot = yield* callTool(agentThread, "preview_snapshot", { includeImage: false });
      expect(snapshot.isError, serialized(snapshot)).toBe(false);
      expect(serialized(snapshot)).not.toContain(VALUE);
      expect(serialized(snapshot)).toContain("Your token is [secret]");

      const evaluated = yield* callTool(agentThread, "preview_evaluate", {
        expression: "document.body.innerText",
      });
      expect(evaluated.isError).toBe(false);
      expect(serialized(evaluated)).not.toContain(VALUE);
      expect(serialized(evaluated)).toContain("[secret]");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("another thread's snapshot is not masked by this agent's secrets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveHost("secret-unrelated-host", (operation) =>
        operation === "evaluate" ? `plain ${VALUE}` : undefined,
      );
      const evaluated = yield* callTool(strangerThread, "preview_evaluate", {
        expression: "document.title",
      });
      expect(serialized(evaluated)).toContain(VALUE);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const typed = (requests: ReadonlyArray<HostRequest>) =>
  requests.filter((request) => request.operation === "type");

it.effect("every browser tool masks its result and its tool icon, not only snapshots", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveHost("secret-all-tools-host", (operation) =>
        operation === "status" || operation === "click" || operation === "scroll"
          ? {
              tabId,
              available: true,
              visible: true,
              loading: false,
              title: `Key ${VALUE}`,
              url: `https://example.test/?key=${encodeURIComponent(VALUE)}&q=${VALUE}`,
            }
          : undefined,
      );
      for (const [name, args] of [
        ["preview_status", {}],
        ["preview_click", { locator: "role=button" }],
        ["preview_scroll", { deltaY: 100 }],
      ] as const) {
        const result = yield* callTool(agentThread, name, args);
        expect(serialized(result), name).not.toContain(VALUE);
        expect(serialized(result), name).not.toContain(encodeURIComponent(VALUE));
        expect(serialized(result), name).toContain("[secret]");
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("a browser call is withheld before it runs when the agent's secrets cannot be read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost("secret-closed-host");
      const result = yield* callTool(brokenThread, "preview_status", {});
      expect(result.isError).toBe(true);
      expect(serialized(result)).toContain("withheld");
      expect(yield* Ref.get(requests)).toEqual([]);
      const typing = yield* callTool(brokenThread, "preview_type", {
        secretName: "GITHUB_TOKEN",
      });
      expect(typing.isError).toBe(true);
      expect(typed(yield* Ref.get(requests))).toEqual([]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

const pageAt = (url: string | null) => (operation: string) =>
  operation === "status"
    ? { tabId, available: true, visible: true, loading: false, url }
    : undefined;

it.effect("a secret limited to a site is typed only when the page is on that site", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost(
        "secret-origin-ok-host",
        pageAt("https://app.example.test/settings?tab=keys"),
      );
      const result = yield* callType(agentThread, {
        secretName: "LIMITED_TOKEN",
        locator: "role=textbox",
      });
      expect(result.isError, serialized(result)).toBe(false);
      expect(typed(yield* Ref.get(requests))[0]?.input).toMatchObject({ text: VALUE });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "a secret limited to a site is refused on another site, naming the secret and the origin",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* serveHost(
          "secret-origin-bad-host",
          pageAt("https://evil.example.org/login"),
        );
        const result = yield* callType(agentThread, {
          secretName: "LIMITED_TOKEN",
          locator: "role=textbox",
        });
        expect(result.isError).toBe(true);
        const text = serialized(result);
        expect(text).toContain("LIMITED_TOKEN");
        expect(text).toContain("https://evil.example.org");
        expect(text).toContain("Nothing was typed");
        expect(text).not.toContain(VALUE);
        expect(typed(yield* Ref.get(requests))).toEqual([]);
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect("a secret limited to a site is refused when the page's site cannot be determined", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* serveHost("secret-origin-unknown-host", pageAt(null));
      const blank = yield* callType(agentThread, { secretName: "LIMITED_TOKEN" });
      expect(blank.isError).toBe(true);
      expect(serialized(blank)).toContain("could not be determined");
      expect(typed(yield* Ref.get(requests))).toEqual([]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "a secret with no allowed sites is typed on any page without asking for its address",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* serveHost("secret-any-site-host", pageAt("https://anywhere.test/"));
        const result = yield* callType(agentThread, { secretName: "GITHUB_TOKEN" });
        expect(result.isError).toBe(false);
        expect(typed(yield* Ref.get(requests)).length).toBe(1);
      }),
    ).pipe(Effect.provide(TestLayer)),
);
