import { assert, it } from "@effect/vitest";
import {
  AgentSecretError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AgentSecretSummary,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

import * as AgentSecrets from "../agents/AgentSecrets.ts";
import * as AgentSecretsMcpService from "./AgentSecretsMcpService.ts";
import { restrictScope } from "./AgentToolAccess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const show = (value: unknown): string => JSON.stringify(value);

const makeAgent = (id: string, primary: string) =>
  ({
    profile: { id, name: id },
    revision: 1,
    primaryThreadId: primary,
  }) as unknown as WorkspaceAgent;

const agents = [makeAgent("agent-own", "thread-own"), makeAgent("agent-other", "thread-other")];

const summary = (agentId: string, name: string): AgentSecretSummary => ({
  id: `secret:${agentId}:${name}`,
  agentId,
  name,
  label: `${name} label`,
  kind: "api_key",
  allowedOrigins: [],
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  lastUsedAt: null,
});
const held = [summary("agent-own", "OWN_KEY"), summary("agent-other", "OTHER_KEY")];

const scopeFor = (
  threadId: string,
  capabilities: ReadonlyArray<"orchestration"> = ["orchestration"],
) =>
  ({
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make(threadId),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  }) satisfies McpInvocationScope;

type Call = { readonly method: string; readonly input: unknown };

const harness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const record = (method: string, input: unknown) =>
    Ref.update(calls, (all) => [...all, { method, input }]);
  const secretsLayer = Layer.mock(AgentSecrets.AgentSecrets)({
    agentForThread: (threadId) => {
      const own = agents.find((agent) => agent.primaryThreadId === threadId);
      return own === undefined
        ? Effect.fail(new AgentSecretError({ reason: "not_an_agent_thread" }))
        : Effect.succeed({ agentId: own.profile.id, archived: false });
    },
    createRequest: (input) =>
      record("createRequest", input).pipe(
        Effect.as({ status: "requested" as const, name: input.name, requestId: "secretreq:1" }),
      ),
    list: (input) =>
      record("list", input).pipe(
        Effect.as({ secrets: held.filter((secret) => secret.agentId === input.agentId) }),
      ),
    useFile: (input) =>
      record("useFile", input).pipe(
        Effect.andThen(
          held.some((secret) => secret.agentId === input.agentId && secret.name === input.name)
            ? Effect.succeed(`/state/agent-secret-files/hash/${input.name}`)
            : Effect.fail(new AgentSecretError({ reason: "secret_not_found" })),
        ),
      ),
    useForTyping: (input) =>
      record("useForTyping", input).pipe(
        Effect.as({ value: Redacted.make("typed-value-for-test"), allowedOrigins: [] }),
      ),
    valuesForThread: (threadId) =>
      threadId === "thread-broken"
        ? Effect.fail(new AgentSecretError({ reason: "storage" }))
        : Effect.succeed(threadId === "thread-own" ? [Redacted.make("own key/secret & more")] : []),
  });
  const layer = AgentSecretsMcpService.layer.pipe(Layer.provide(secretsLayer));
  return { calls, layer };
});

it.effect("the tools act for the calling thread's own agent and nobody else", () =>
  Effect.gen(function* () {
    const { calls, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* AgentSecretsMcpService.AgentSecretsMcpService;
      const scope = scopeFor("thread-own");

      const requested = yield* service.request(scope, {
        name: "STRIPE_API_KEY",
        label: "Stripe",
        reason: "To create a product.",
        kind: "api_key",
      });
      assert.equal(requested.status, "requested");

      const listed = yield* service.list(scope);
      assert.equal(listed.agentId, "agent-own");
      assert.deepEqual(
        listed.secrets.map((secret) => secret.name),
        ["OWN_KEY"],
      );
      assert.notInclude(show(listed), "secret:agent-own");

      const file = yield* service.file(scope, { name: "OWN_KEY" });
      assert.equal(file.path, "/state/agent-secret-files/hash/OWN_KEY");

      // Another agent's secret answers like a missing one.
      const other = yield* Effect.flip(service.file(scope, { name: "OTHER_KEY" }));
      assert.equal(other._tag, "OrchestratorMcpFailure");
      assert.include(other.message, "no secret with that name");

      const typed = yield* service.typingValue(scope, "OWN_KEY");
      assert.equal(Redacted.value(typed.value), "typed-value-for-test");

      const all = yield* Ref.get(calls);
      for (const call of all) {
        assert.equal((call.input as { agentId: string }).agentId, "agent-own", call.method);
      }
      assert.deepEqual(
        all.map((call) => call.method),
        ["createRequest", "list", "useFile", "useFile", "useForTyping"],
      );
      const first = all.find((call) => call.method === "createRequest");
      assert.equal((first?.input as { threadId: string } | undefined)?.threadId, "thread-own");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("the tools keep working when Other Conversations is switched off", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* AgentSecretsMcpService.AgentSecretsMcpService;
      const off = restrictScope(scopeFor("thread-own"), ["orchestration"]);
      assert.isFalse(off.capabilities.has("orchestration"));
      assert.isTrue(off.blockedGroups?.has("orchestration") === true);
      const listed = yield* service.list(off);
      assert.equal(listed.agentId, "agent-own");
      const requested = yield* service.request(off, {
        name: "STRIPE_API_KEY",
        label: "Stripe",
        reason: "To create a product.",
        kind: "api_key",
      });
      assert.equal(requested.status, "requested");
      const file = yield* service.file(off, { name: "OWN_KEY" });
      assert.include(file.path, "OWN_KEY");
      // The browser typing path does not depend on that group at all.
      const typed = yield* service.typingValue(off, "OWN_KEY");
      assert.equal(Redacted.value(typed.value), "typed-value-for-test");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "a credential without orchestration is refused, and a stranger thread is not an agent",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* AgentSecretsMcpService.AgentSecretsMcpService;
        const denied = yield* Effect.flip(service.list(scopeFor("thread-own", [])));
        assert.include(denied.message, "orchestration");
        const stranger = yield* Effect.flip(service.list(scopeFor("thread-nobody")));
        assert.include(stranger.message, "does not belong to an agent");
        const strangerTyping = yield* Effect.flip(
          service.typingValue(scopeFor("thread-nobody"), "OWN_KEY"),
        );
        assert.equal(strangerTyping._tag, "PreviewAutomationSecretUnavailableError");
        assert.equal(strangerTyping.reason, "not_an_agent_thread");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "the redactor masks a value in plain and URL-encoded forms, and only for its own agent",
  () =>
    Effect.gen(function* () {
      const { layer } = yield* harness;
      yield* Effect.gen(function* () {
        const service = yield* AgentSecretsMcpService.AgentSecretsMcpService;
        const redact = yield* service.redactor(scopeFor("thread-own"));
        const page = {
          url: "https://example.test/?k=own%20key%2Fsecret%20%26%20more&q=own+key%2Fsecret+%26+more",
          title: "own key/secret & more",
          nested: [{ text: "token own key/secret & more!" }],
          count: 3,
        };
        const masked = show(redact(page));
        assert.notInclude(masked, "own key");
        assert.notInclude(masked, "own%20key");
        assert.notInclude(masked, "own+key");
        assert.include(masked, "[secret]");
        assert.include(masked, '"count":3');
        // A thread with no secrets gets the identity function.
        const plain = yield* service.redactor(scopeFor("thread-other"));
        assert.equal(show(plain(page)), show(page));
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("the redactor fails closed when the agent's secrets cannot be read", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* AgentSecretsMcpService.AgentSecretsMcpService;
      const failed = yield* Effect.flip(service.redactor(scopeFor("thread-broken")));
      assert.equal(failed._tag, "PreviewAutomationSecretUnavailableError");
      assert.equal(failed.reason, "masking_unavailable");
    }).pipe(Effect.provide(layer));
  }),
);
