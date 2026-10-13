import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AGENT_SECRET_MAX_PENDING_PER_AGENT,
  AGENT_SECRET_MAX_PER_AGENT,
  AGENT_SECRET_REQUEST_TTL_MS,
  AGENT_SECRET_VALUE_MAX_BYTES,
  AgentSecretError,
  AgentSecretName,
  AgentSecretRequestProvideInput,
  AgentSecretSetInput,
  ThreadId,
  WS_METHODS,
  type ProjectId,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentSecrets from "./AgentSecrets.ts";
import * as AgentWorkspace from "./AgentWorkspace.ts";

const projectId = "project-1" as ProjectId;
const shell = { projectId, archivedAt: null } as const;
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
/** Distinctive on purpose: every leak check below searches for this string. */
const VALUE = "sk_live_Zq9-needle-4471";

const makeAgent = (id: string, primary: ThreadId, archivedAt?: string): WorkspaceAgent => ({
  profile: {
    id,
    name: id,
    description: "",
    instructions: "",
    color: "#ffffff",
    pinned: false,
    projectKey: "",
    runtimeMode: "inherit",
    modelSelection: null,
  },
  revision: 0,
  archive: null,
  recovery: { disposition: "ready", summary: "", blockers: [], verifiedAt: null, evidence: [] },
  memories: [],
  primaryThreadId: primary,
  ...(archivedAt === undefined ? {} : { archivedAt }),
  updatedAt: "2026-10-04T00:00:00.000Z",
});

type SentMessage = Parameters<
  ThreadManagementService.ThreadManagementServiceShape["sendToThread"]
>[0];

interface Fakes {
  readonly sent: Ref.Ref<ReadonlyArray<SentMessage>>;
  readonly shellArchived: Ref.Ref<boolean>;
  /** Make telling the thread fail. */
  readonly failSend: Ref.Ref<boolean>;
  /** Make the server secret store refuse writes or removals. */
  readonly failStoreSet: Ref.Ref<boolean>;
  readonly failStoreRemove: Ref.Ref<boolean>;
  /** How many values the secret store was asked to read. */
  readonly storeReads: Ref.Ref<number>;
}

/** Real stores, secret store and agent store on disk and in memory; only the thread service is faked. */
const makeLayer = (fakes: Fakes) => {
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Ref.get(fakes.shellArchived).pipe(
        Effect.map(
          (archived) =>
            ({ ...shell, archivedAt: archived ? "2026-10-04T00:00:00.000Z" : null }) as never,
        ),
      ),
    sendToThread: (input) =>
      Ref.get(fakes.failSend).pipe(
        Effect.flatMap((fail) =>
          fail
            ? Effect.die("sendToThread failed on purpose")
            : Ref.update(fakes.sent, (all) => [...all, input]).pipe(Effect.as({} as never)),
        ),
      ),
  });
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-secrets-test-" });
  const realStore = ServerSecretStore.layer.pipe(Layer.provide(config));
  const refusal = new ServerSecretStore.SecretStorePersistError({
    resource: "secret",
    cause: "refused on purpose",
  });
  const instrumentedStore = Layer.effect(
    ServerSecretStore.ServerSecretStore,
    Effect.gen(function* () {
      const real = yield* ServerSecretStore.ServerSecretStore;
      return ServerSecretStore.ServerSecretStore.of({
        ...real,
        get: (name) =>
          Ref.update(fakes.storeReads, (n) => n + 1).pipe(Effect.andThen(real.get(name))),
        set: (name, value) =>
          Ref.get(fakes.failStoreSet).pipe(
            Effect.flatMap((fail) => (fail ? Effect.fail(refusal) : real.set(name, value))),
          ),
        remove: (name) =>
          Ref.get(fakes.failStoreRemove).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(
                    new ServerSecretStore.SecretStoreRemoveError({
                      resource: "secret",
                      cause: "refused on purpose",
                    }),
                  )
                : real.remove(name),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide(realStore));
  const base = Layer.mergeAll(AgentWorkspace.layer, threads, instrumentedStore, config).pipe(
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return AgentSecrets.layer.pipe(Layer.provideMerge(base));
};

const withHarness = <A, E>(
  body: (
    fakes: Fakes,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>> | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fakes = {
      sent: yield* Ref.make<ReadonlyArray<SentMessage>>([]),
      shellArchived: yield* Ref.make(false),
      failSend: yield* Ref.make(false),
      failStoreSet: yield* Ref.make(false),
      failStoreRemove: yield* Ref.make(false),
      storeReads: yield* Ref.make(0),
    } satisfies Fakes;
    return yield* Effect.scoped(body(fakes).pipe(Effect.provide(makeLayer(fakes))));
  });

const seedAgents = Effect.gen(function* () {
  const workspace = yield* AgentWorkspace.AgentWorkspace;
  yield* workspace.save({ agent: makeAgent("agent-a", threadA), expectedRevision: 0 });
  yield* workspace.save({ agent: makeAgent("agent-b", threadB), expectedRevision: 0 });
});

const secretInput = (
  overrides: Partial<{
    name: string;
    value: string;
    agentId: string;
    label: string;
    allowedOrigins: ReadonlyArray<string>;
  }> = {},
) => ({
  agentId: overrides.agentId ?? "agent-a",
  name: overrides.name ?? "STRIPE_API_KEY",
  label: overrides.label ?? "Stripe live API key",
  kind: "api_key" as const,
  ...(overrides.allowedOrigins === undefined ? {} : { allowedOrigins: overrides.allowedOrigins }),
  value: Redacted.make(overrides.value ?? VALUE),
});

const requestInput = (
  name: string,
  overrides: {
    replace?: boolean;
    label?: string;
    reason?: string;
    suggestedOrigin?: string;
  } = {},
) => ({
  agentId: "agent-a",
  threadId: threadA,
  name,
  label: overrides.label ?? "Stripe live API key",
  reason: overrides.reason ?? "I need to create a product in the dashboard.",
  kind: "api_key" as const,
  ...(overrides.suggestedOrigin === undefined
    ? {}
    : { suggestedOrigin: overrides.suggestedOrigin }),
  replace: overrides.replace ?? false,
});

/** Text for leak checks; BigInt span times have no JSON form, so they are written out. */
const show = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );

/** Every row of both secret tables, as text, to prove no value is ever a column. */
const dumpTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* sql`SELECT * FROM workbench_agent_secrets`;
  const requests = yield* sql`SELECT * FROM workbench_agent_secret_requests`;
  return show({ secrets, requests });
});

const failureOf = <A>(effect: Effect.Effect<A, AgentSecretError>) => Effect.flip(effect);

it.effect("set, list and delete never return or store the value in SQLite", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const store = yield* ServerSecretStore.ServerSecretStore;

      const summary = yield* secrets.set(secretInput());
      assert.equal(summary.name, "STRIPE_API_KEY");
      assert.equal(summary.lastUsedAt, null);
      assert.notInclude(show(summary), VALUE);

      const listed = yield* secrets.list({ agentId: "agent-a" });
      assert.equal(listed.secrets.length, 1);
      assert.notInclude(show(listed), VALUE);
      assert.notInclude(yield* dumpTables, VALUE);

      // The value is in the server secret store (a 0600 file named by hashed agent id and secret
      // name), and nowhere in the tables.
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = store.directory ?? "";
      const names = (yield* fileSystem.readDirectory(directory)).filter((name) =>
        name.endsWith("-STRIPE_API_KEY.bin"),
      );
      assert.equal(names.length, 1);
      assert.notInclude(names[0] ?? "", "agent-a");
      assert.equal(yield* fileSystem.readFileString(`${directory}/${names[0]}`), VALUE);
      assert.equal((yield* fileSystem.stat(`${directory}/${names[0]}`)).mode & 0o777, 0o600);
      const withBytes = yield* secrets.useForTyping({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      assert.equal(Redacted.value(withBytes.value), VALUE);

      // Replacing keeps one row and updates the value.
      yield* secrets.set(secretInput({ value: "second-value-9" }));
      assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 1);
      assert.equal(
        Redacted.value(
          (yield* secrets.useForTyping({ agentId: "agent-a", name: "STRIPE_API_KEY" })).value,
        ),
        "second-value-9",
      );

      // Another agent sees none of it.
      assert.equal((yield* secrets.list({ agentId: "agent-b" })).secrets.length, 0);

      const removed = yield* secrets.remove({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      assert.equal(removed.name, "STRIPE_API_KEY");
      assert.equal((yield* secrets.list({})).secrets.length, 0);
      const gone = yield* failureOf(
        secrets.useForTyping({ agentId: "agent-a", name: "STRIPE_API_KEY" }),
      );
      assert.equal(gone.reason, "secret_not_found");
      const again = yield* failureOf(
        secrets.remove({ agentId: "agent-a", name: "STRIPE_API_KEY" }),
      );
      assert.equal(again.reason, "secret_not_found");
    }),
  ),
);

it.effect("a request answered by provide stores the value and queues one message without it", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;

      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      assert.equal(asked.status, "requested");
      const requestId = asked.requestId ?? "";
      const waiting = yield* secrets.listRequests;
      assert.equal(waiting.requests.length, 1);
      assert.equal(waiting.requests[0]?.threadId, threadA);
      assert.equal(waiting.requests[0]?.status, "pending");

      const answered = yield* secrets.provide({ requestId, value: Redacted.make(VALUE) });
      assert.equal(answered.status, "provided");
      assert.notInclude(show(answered), VALUE);
      assert.equal((yield* secrets.listRequests).requests.length, 0);

      const sent = yield* Ref.get(fakes.sent);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.mode, "queue");
      assert.equal(sent[0]?.threadId, threadA);
      assert.equal(
        sent[0]?.text,
        "The owner provided the secret STRIPE_API_KEY. Use secret_file or the browser typing tool's secretName to use it. Do not print its value.",
      );
      assert.notInclude(show(sent), VALUE);
      assert.equal(sent[0]?.commandId, `agent-secret-provided:${requestId}`);

      assert.equal(
        Redacted.value(
          (yield* secrets.useForTyping({ agentId: "agent-a", name: "STRIPE_API_KEY" })).value,
        ),
        VALUE,
      );
      assert.notInclude(yield* dumpTables, VALUE);

      // A second answer is refused and queues nothing more.
      const replay = yield* failureOf(secrets.provide({ requestId, value: Redacted.make(VALUE) }));
      assert.equal(replay.reason, "request_resolved");
      assert.equal((yield* Ref.get(fakes.sent)).length, 1);

      // Once the secret exists, asking again says it is available unless replace is set.
      const available = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      assert.equal(available.status, "available");
      const replace = yield* secrets.createRequest(
        requestInput("STRIPE_API_KEY", { replace: true }),
      );
      assert.equal(replace.status, "requested");
    }),
  ),
);

it.effect("adding the secret by hand answers the request the agent has open for it", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      yield* secrets.createRequest(requestInput("OTHER_KEY"));
      yield* secrets.set(secretInput());
      const waiting = yield* secrets.listRequests;
      assert.deepEqual(
        waiting.requests.map((request) => request.name),
        ["OTHER_KEY"],
      );
      const sent = yield* Ref.get(fakes.sent);
      assert.equal(sent.length, 1);
      assert.include(sent[0]?.text ?? "", "STRIPE_API_KEY");
      assert.notInclude(show(sent), VALUE);
    }),
  ),
);

it.effect("declining queues a message and stores nothing", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      const declined = yield* secrets.decline({ requestId: asked.requestId ?? "" });
      assert.equal(declined.status, "declined");
      assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 0);
      const sent = yield* Ref.get(fakes.sent);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.text, "The owner declined to provide the secret STRIPE_API_KEY.");
      const again = yield* failureOf(secrets.decline({ requestId: asked.requestId ?? "" }));
      assert.equal(again.reason, "request_resolved");
    }),
  ),
);

it.effect("a gone thread still records the answer but is not messaged", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      yield* Ref.set(fakes.shellArchived, true);
      const answered = yield* secrets.provide({
        requestId: asked.requestId ?? "",
        value: Redacted.make(VALUE),
      });
      assert.equal(answered.status, "provided");
      assert.equal((yield* Ref.get(fakes.sent)).length, 0);
    }),
  ),
);

it.effect("a request left unanswered for a day reads as expired and cannot be answered", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      assert.equal((yield* secrets.listRequests).requests.length, 1);
      yield* TestClock.adjust(Duration.millis(AGENT_SECRET_REQUEST_TTL_MS + 1_000));
      assert.equal((yield* secrets.listRequests).requests.length, 0);
      const late = yield* failureOf(
        secrets.provide({ requestId: asked.requestId ?? "", value: Redacted.make(VALUE) }),
      );
      assert.equal(late.reason, "request_expired");
      assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 0);
      // An expired request no longer counts against the cap, and the same name can be asked again.
      const fresh = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      assert.equal(fresh.status, "requested");
      assert.notEqual(fresh.requestId, asked.requestId);
    }),
  ),
);

it.effect("caps pending requests and secrets per agent, and merges a repeated request", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const first = yield* secrets.createRequest(requestInput("KEY_0"));
      const repeat = yield* secrets.createRequest(requestInput("KEY_0"));
      assert.equal(repeat.requestId, first.requestId);
      for (let index = 1; index < AGENT_SECRET_MAX_PENDING_PER_AGENT; index++) {
        yield* secrets.createRequest(requestInput(`KEY_${index}`));
      }
      const over = yield* failureOf(secrets.createRequest(requestInput("ONE_TOO_MANY")));
      assert.equal(over.reason, "request_limit");
      // The other agent has its own allowance.
      assert.equal(
        (yield* secrets.createRequest({
          ...requestInput("KEY_0"),
          agentId: "agent-b",
          threadId: threadB,
        })).status,
        "requested",
      );

      for (let index = 0; index < AGENT_SECRET_MAX_PER_AGENT; index++) {
        yield* secrets.set(secretInput({ name: `HELD_${index}`, value: `value-${index}` }));
      }
      const full = yield* failureOf(secrets.set(secretInput({ name: "HELD_EXTRA" })));
      assert.equal(full.reason, "secret_limit");
      // Replacing an existing one is still fine at the cap.
      yield* secrets.set(secretInput({ name: "HELD_0", value: "replaced" }));
    }),
  ),
);

it.effect("refuses empty and oversized values without quoting them", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const empty = yield* failureOf(secrets.set(secretInput({ value: "" })));
      assert.equal(empty.reason, "value_empty");
      const huge = `${VALUE}${"x".repeat(AGENT_SECRET_VALUE_MAX_BYTES)}`;
      const tooLarge = yield* failureOf(secrets.set(secretInput({ value: huge })));
      assert.equal(tooLarge.reason, "value_too_large");
      assert.notInclude(tooLarge.message, VALUE);
      assert.notInclude(show(tooLarge), VALUE);
      // Exactly at the limit is accepted.
      yield* secrets.set(secretInput({ value: "y".repeat(AGENT_SECRET_VALUE_MAX_BYTES) }));
      assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 1);
    }),
  ),
);

it("secret names must be env-var style", () => {
  const decode = Schema.decodeUnknownExit(AgentSecretName);
  for (const bad of [
    "lower",
    "1ABC",
    "HAS-DASH",
    "HAS SPACE",
    "",
    "A".repeat(65),
    "../ETC",
    "A/B",
  ]) {
    assert.isTrue(Exit.isFailure(decode(bad)), `expected ${show(bad)} to be refused`);
  }
  for (const good of ["A", "STRIPE_API_KEY", "A".repeat(64), "K9_X"]) {
    assert.isTrue(Exit.isSuccess(decode(good)), `expected ${good} to be accepted`);
  }
});

const decodeSetInput = Schema.decodeUnknownSync(AgentSecretSetInput);
const encodeSetInput = Schema.encodeSync(AgentSecretSetInput);
const decodeProvideInput = Schema.decodeUnknownSync(AgentSecretRequestProvideInput);

it("the wire payloads decode the value into a Redacted that prints as redacted", () => {
  const decoded = decodeSetInput({
    agentId: "agent-a",
    name: "STRIPE_API_KEY",
    label: "Stripe",
    kind: "api_key",
    value: VALUE,
  });
  assert.isTrue(Redacted.isRedacted(decoded.value));
  assert.notInclude(String(decoded.value), VALUE);
  assert.notInclude(show(decoded), VALUE);
  assert.notInclude(show({ decoded }), VALUE);
  // The client's own encode still puts the value on the wire.
  assert.equal(encodeSetInput(decoded).value, VALUE);
  const provide = decodeProvideInput({
    requestId: "r",
    value: VALUE,
  });
  assert.notInclude(show(provide), VALUE);
});

it.effect("secret_file path, mode, content, idempotence, refresh and removal", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* secrets.set(secretInput());

      const path = yield* secrets.useFile({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      assert.isTrue(
        path.startsWith(`${config.stateDir}/${AgentSecrets.AGENT_SECRET_FILES_DIRECTORY}/`),
      );
      assert.isTrue(path.endsWith("/STRIPE_API_KEY"));
      // Test state lives in an isolated temporary directory. The secret belongs
      // under that state, never in the project or directly in the shared temp root.
      assert.isFalse(path.startsWith(`${config.cwd}/`));
      assert.equal(yield* fileSystem.readFileString(path), VALUE);
      const mode = (yield* fileSystem.stat(path)).mode & 0o777;
      assert.equal(mode, 0o600);
      const directoryMode =
        (yield* fileSystem.stat(path.slice(0, path.lastIndexOf("/")))).mode & 0o777;
      assert.equal(directoryMode, 0o700);
      const rootMode =
        (yield* fileSystem.stat(`${config.stateDir}/${AgentSecrets.AGENT_SECRET_FILES_DIRECTORY}`))
          .mode & 0o777;
      assert.equal(rootMode, 0o700);

      // Same path every time, nothing else left in the directory.
      assert.equal(yield* secrets.useFile({ agentId: "agent-a", name: "STRIPE_API_KEY" }), path);
      assert.deepEqual(yield* fileSystem.readDirectory(path.slice(0, path.lastIndexOf("/"))), [
        "STRIPE_API_KEY",
      ]);
      const used = (yield* secrets.list({ agentId: "agent-a" })).secrets[0];
      assert.isString(used?.lastUsedAt);

      // A changed value is rewritten in place for a file the agent already knows about.
      yield* secrets.set(secretInput({ value: "rotated-value-2" }));
      assert.equal(yield* fileSystem.readFileString(path), "rotated-value-2");
      assert.equal((yield* fileSystem.stat(path)).mode & 0o777, 0o600);

      // The second agent writes to its own directory and cannot reach this one.
      yield* secrets.set(
        secretInput({ agentId: "agent-b", name: "STRIPE_API_KEY", value: "b-value" }),
      );
      const otherPath = yield* secrets.useFile({ agentId: "agent-b", name: "STRIPE_API_KEY" });
      assert.notEqual(otherPath, path);
      assert.equal(yield* fileSystem.readFileString(otherPath), "b-value");

      yield* secrets.remove({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      assert.isFalse(yield* fileSystem.exists(path));
      assert.isTrue(yield* fileSystem.exists(otherPath));
    }),
  ),
);

it.effect("an archived agent's secrets cannot be used, but are kept", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const workspace = yield* AgentWorkspace.AgentWorkspace;
      yield* workspace.save({
        agent: makeAgent("agent-old", ThreadId.make("thread-old"), "2026-10-04T00:00:00.000Z"),
        expectedRevision: 0,
      });
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.set(secretInput({ agentId: "agent-old" }));
      const file = yield* failureOf(
        secrets.useFile({ agentId: "agent-old", name: "STRIPE_API_KEY" }),
      );
      assert.equal(file.reason, "agent_archived");
      const value = yield* failureOf(
        secrets.useForTyping({ agentId: "agent-old", name: "STRIPE_API_KEY" }),
      );
      assert.equal(value.reason, "agent_archived");
      const ask = yield* failureOf(
        secrets.createRequest({ ...requestInput("OTHER_KEY"), agentId: "agent-old" }),
      );
      assert.equal(ask.reason, "agent_archived");
      assert.equal((yield* secrets.list({ agentId: "agent-old" })).secrets.length, 1);
    }),
  ),
);

it.effect("an agent cannot reach another agent's secret by name or by thread", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.set(secretInput({ agentId: "agent-a" }));
      const owner = yield* secrets.agentForThread(threadB);
      assert.equal(owner.agentId, "agent-b");
      const useA = yield* failureOf(
        secrets.useFile({ agentId: owner.agentId, name: "STRIPE_API_KEY" }),
      );
      assert.equal(useA.reason, "secret_not_found");
      const valueA = yield* failureOf(
        secrets.useForTyping({ agentId: owner.agentId, name: "STRIPE_API_KEY" }),
      );
      assert.equal(valueA.reason, "secret_not_found");
      const stranger = yield* failureOf(
        secrets.agentForThread(ThreadId.make("not-an-agent-thread")),
      );
      assert.equal(stranger.reason, "not_an_agent_thread");
    }),
  ),
);

it.effect("subscribeRequests sends the list first and a fresh one after each change", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const lists: Array<number> = [];
      const reader = yield* secrets.subscribeRequests.pipe(
        Stream.take(3),
        Stream.runForEach((list) => Effect.sync(() => void lists.push(list.requests.length))),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      yield* Effect.yieldNow;
      yield* secrets.decline({ requestId: asked.requestId ?? "" });
      yield* Effect.sleep(Duration.millis(0));
      yield* Effect.yieldNow;
      yield* Fiber.join(reader);
      assert.deepEqual(lists, [0, 1, 0]);
    }),
  ),
);

it.effect("the value never reaches spans, logs or errors when it passes the RPC wrapper", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const spans: Array<Tracer.NativeSpan> = [];
      const logs: Array<string> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logger = Logger.make(({ message }) => {
        logs.push(show(message));
      });

      // The same wrapper `ws.ts` puts around the two calls that carry a value.
      const wrapped = Effect.gen(function* () {
        const asked = yield* secrets.createRequest(requestInput("PAY_KEY"));
        yield* Effect.log("owner answers", Redacted.make(VALUE));
        yield* observeRpcEffect(
          WS_METHODS.agentSecretRequestsProvide,
          secrets.provide({ requestId: asked.requestId ?? "", value: Redacted.make(VALUE) }),
          { "rpc.aggregate": "agents" },
        );
        yield* observeRpcEffect(
          WS_METHODS.agentSecretsSet,
          secrets.set(secretInput({ name: "DIRECT_KEY" })),
          { "rpc.aggregate": "agents" },
        );
        // A refused value is the case most likely to put text into an error and a span.
        const refused = yield* Effect.exit(
          observeRpcEffect(
            WS_METHODS.agentSecretsSet,
            secrets.set(secretInput({ name: "BIG_KEY", value: `${VALUE}${"z".repeat(20_000)}` })),
            { "rpc.aggregate": "agents" },
          ),
        );
        assert.isTrue(Exit.isFailure(refused));
        logs.push(Cause.pretty((refused as Exit.Failure<unknown, unknown>).cause));
      }).pipe(Effect.withTracer(tracer), Effect.provide(Logger.layer([logger])));
      yield* wrapped;

      assert.isAbove(spans.length, 0);
      const everything = show({
        spans: spans.map((span) => ({
          name: span.name,
          attributes: [...span.attributes.entries()],
          events: span.events,
          status: span.status,
        })),
        logs,
        tables: yield* dumpTables,
      });
      assert.notInclude(everything, VALUE);
      assert.notInclude(everything, "needle");
    }),
  ),
);

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/;

const useValueOf = (agentId: string, name: string) =>
  Effect.gen(function* () {
    const secrets = yield* AgentSecrets.AgentSecrets;
    const typing = yield* secrets.useForTyping({ agentId, name });
    return Redacted.value(typing.value);
  });

it.effect("values are trimmed, and anything too short to mask is refused with fixed text", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.set(secretInput({ value: "  abcdef  \n" }));
      assert.equal(yield* useValueOf("agent-a", "STRIPE_API_KEY"), "abcdef");

      const short = yield* failureOf(
        secrets.set(secretInput({ name: "SHORT_KEY", value: "abcde" })),
      );
      assert.equal(short.reason, "value_too_short");
      const padded = yield* failureOf(
        secrets.set(secretInput({ name: "SHORT_KEY", value: "    ab    " })),
      );
      assert.equal(padded.reason, "value_too_short");
      const blank = yield* failureOf(secrets.set(secretInput({ name: "SHORT_KEY", value: "   " })));
      assert.equal(blank.reason, "value_empty");
      assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 1);

      // Answering a request with a value that is too short leaves the request waiting.
      const asked = yield* secrets.createRequest(requestInput("PAY_KEY"));
      const refused = yield* failureOf(
        secrets.provide({ requestId: asked.requestId ?? "", value: Redacted.make(" 12345 ") }),
      );
      assert.equal(refused.reason, "value_too_short");
      assert.equal((yield* secrets.listRequests).requests.length, 1);
      assert.equal((yield* Ref.get(fakes.sent)).length, 0);
    }),
  ),
);

it.effect(
  "allowed origins are validated and normalised, kept on replace and cleared by an empty list",
  () =>
    withHarness(() =>
      Effect.gen(function* () {
        yield* seedAgents;
        const secrets = yield* AgentSecrets.AgentSecrets;
        const saved = yield* secrets.set(
          secretInput({
            allowedOrigins: [
              "https://App.Example.test/some/path?x=1",
              "https://app.example.test",
              "http://localhost:3000/login",
            ],
          }),
        );
        assert.deepEqual(saved.allowedOrigins, [
          "https://app.example.test",
          "http://localhost:3000",
        ]);

        for (const bad of ["http://example.test", "app.example.test", "ftp://example.test", ""]) {
          const refused = yield* failureOf(
            secrets.set(secretInput({ name: "OTHER_KEY", allowedOrigins: [bad] })),
          );
          assert.equal(refused.reason, "invalid_origin", bad);
        }
        assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 1);

        // Replacing the value without naming sites keeps them; an empty list opens it to any site.
        const kept = yield* secrets.set(secretInput({ value: "a-new-value-1" }));
        assert.deepEqual(kept.allowedOrigins, [
          "https://app.example.test",
          "http://localhost:3000",
        ]);
        const opened = yield* secrets.set(
          secretInput({ value: "a-new-value-2", allowedOrigins: [] }),
        );
        assert.deepEqual(opened.allowedOrigins, []);
        const typing = yield* secrets.useForTyping({ agentId: "agent-a", name: "STRIPE_API_KEY" });
        assert.deepEqual(typing.allowedOrigins, []);
      }),
    ),
);

it.effect("a request that replaces a saved secret says so and keeps what the owner saved", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.set(
        secretInput({ label: "Mine", allowedOrigins: ["https://app.example.test"] }),
      );
      yield* secrets.createRequest(
        requestInput("STRIPE_API_KEY", { replace: true, label: "Agent label" }),
      );
      yield* secrets.createRequest(requestInput("BRAND_NEW_KEY"));
      const waiting = (yield* secrets.listRequests).requests;
      assert.deepEqual(
        waiting.map((request) => [request.name, request.replaces]),
        [
          ["STRIPE_API_KEY", true],
          ["BRAND_NEW_KEY", false],
        ],
      );

      const answered = yield* secrets.provide({
        requestId: waiting[0]?.id ?? "",
        value: Redacted.make("replacement-value-1"),
        // Whatever the answer carries, a replace keeps the sites the owner saved.
        allowedOrigins: ["https://elsewhere.test"],
      });
      assert.equal(answered.replaces, true);
      const kept = (yield* secrets.list({ agentId: "agent-a" })).secrets[0];
      assert.equal(kept?.label, "Mine");
      assert.deepEqual(kept?.allowedOrigins, ["https://app.example.test"]);
      assert.equal(yield* useValueOf("agent-a", "STRIPE_API_KEY"), "replacement-value-1");

      // A new secret takes the sites the owner chose in the dialog, and the agent's label.
      const fresh = yield* secrets.provide({
        requestId: waiting[1]?.id ?? "",
        value: Redacted.make("brand-new-value"),
        allowedOrigins: ["https://New.Example.test/x"],
      });
      assert.equal(fresh.replaces, false);
      const created = (yield* secrets.list({ agentId: "agent-a" })).secrets.find(
        (secret) => secret.name === "BRAND_NEW_KEY",
      );
      assert.equal(created?.label, "Stripe live API key");
      assert.deepEqual(created?.allowedOrigins, ["https://new.example.test"]);
    }),
  ),
);

it.effect("what the agent wrote is cleaned of control and bidi characters and bounded", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      yield* secrets.createRequest(
        requestInput("STRIPE_API_KEY", {
          label: "‮Evil​\u0007 label\nmore⁦\u0085",
          reason: `Because\r\nI\tsaid so\u0000‏${"x".repeat(5_000)}`,
          suggestedOrigin: " https://App.Example.test/a‮/b ",
        }),
      );
      yield* secrets.createRequest(
        requestInput("OTHER_KEY", {
          label: "x".repeat(400),
          suggestedOrigin: "not an origin‮",
        }),
      );
      const [first, second] = (yield* secrets.listRequests).requests;
      assert.equal(first?.label, "Evil label more");
      assert.match(first?.reason ?? "", /^Because I said so/);
      assert.isFalse(HIDDEN.test(`${first?.label}${first?.reason}`));
      assert.isAtMost(first?.reason.length ?? 0, 1_000);
      assert.equal(first?.suggestedOrigin, "https://app.example.test");
      assert.equal(second?.label.length, 120);
      assert.equal(second?.suggestedOrigin, null);
    }),
  ),
);

it.effect(
  "a provide is recorded even when the thread cannot be told, and a failed store undoes the claim",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgents;
        const secrets = yield* AgentSecrets.AgentSecrets;

        yield* Ref.set(fakes.failSend, true);
        const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
        const answered = yield* secrets.provide({
          requestId: asked.requestId ?? "",
          value: Redacted.make(VALUE),
        });
        assert.equal(answered.status, "provided");
        assert.equal(yield* useValueOf("agent-a", "STRIPE_API_KEY"), VALUE);
        assert.equal((yield* secrets.listRequests).requests.length, 0);
        yield* Ref.set(fakes.failSend, false);

        // The store refuses the value: the request is waiting again and the agent was told nothing.
        const second = yield* secrets.createRequest(requestInput("OTHER_KEY"));
        yield* Ref.set(fakes.failStoreSet, true);
        const failed = yield* failureOf(
          secrets.provide({ requestId: second.requestId ?? "", value: Redacted.make(VALUE) }),
        );
        assert.equal(failed.reason, "storage");
        assert.notInclude(failed.message, VALUE);
        assert.deepEqual(
          (yield* secrets.listRequests).requests.map((request) => request.name),
          ["OTHER_KEY"],
        );
        assert.equal((yield* Ref.get(fakes.sent)).length, 0);
        yield* Ref.set(fakes.failStoreSet, false);
        const retried = yield* secrets.provide({
          requestId: second.requestId ?? "",
          value: Redacted.make(VALUE),
        });
        assert.equal(retried.status, "provided");
      }),
    ),
);

it.effect("a provide racing a decline ends one way, never declined with a value stored", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const sql = yield* SqlClient.SqlClient;
      for (let trial = 0; trial < 6; trial++) {
        const name = `RACE_${trial}`;
        const asked = yield* secrets.createRequest(requestInput(name));
        const requestId = asked.requestId ?? "";
        const [provided, declined] = yield* Effect.all(
          [
            Effect.result(secrets.provide({ requestId, value: Redacted.make(VALUE) })),
            Effect.result(secrets.decline({ requestId })),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal([provided, declined].filter((result) => result._tag === "Success").length, 1);
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM workbench_agent_secret_requests WHERE id = ${requestId}
        `;
        const held = (yield* secrets.list({ agentId: "agent-a" })).secrets.some(
          (secret) => secret.name === name,
        );
        assert.equal(rows[0]?.status, held ? "provided" : "declined");
        assert.equal(provided._tag === "Success", held);
      }
    }),
  ),
);

it.effect(
  "deleting removes the value and the file before the metadata, so a failure leaves nothing orphaned",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgents;
        const secrets = yield* AgentSecrets.AgentSecrets;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* secrets.set(secretInput());
        const path = yield* secrets.useFile({ agentId: "agent-a", name: "STRIPE_API_KEY" });

        yield* Ref.set(fakes.failStoreRemove, true);
        const failed = yield* failureOf(
          secrets.remove({ agentId: "agent-a", name: "STRIPE_API_KEY" }),
        );
        assert.equal(failed.reason, "storage");
        // The metadata row is still there, so the owner can see it and try again.
        assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 1);

        yield* Ref.set(fakes.failStoreRemove, false);
        yield* secrets.remove({ agentId: "agent-a", name: "STRIPE_API_KEY" });
        assert.isFalse(yield* fileSystem.exists(path));
        assert.equal((yield* secrets.list({ agentId: "agent-a" })).secrets.length, 0);
      }),
    ),
);

it.effect("writing a secret file clears stale temporary files from the agent's directory", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* secrets.set(secretInput());
      const path = yield* secrets.useFile({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      const directory = path.slice(0, path.lastIndexOf("/"));
      yield* fileSystem.writeFileString(
        `${directory}/STRIPE_API_KEY.old-crash.tmp`,
        "half a value",
      );
      yield* fileSystem.writeFileString(`${directory}/OTHER.old-crash.tmp`, "half a value");
      yield* secrets.set(secretInput({ value: "rotated-value-3" }));
      assert.deepEqual(yield* fileSystem.readDirectory(directory), ["STRIPE_API_KEY"]);
      yield* fileSystem.writeFileString(`${directory}/LATE.old-crash.tmp`, "x");
      yield* secrets.useFile({ agentId: "agent-a", name: "STRIPE_API_KEY" });
      assert.deepEqual(yield* fileSystem.readDirectory(directory), ["STRIPE_API_KEY"]);
    }),
  ),
);

it.effect("parallel requests cannot open two for one name or go past the cap", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const sql = yield* SqlClient.SqlClient;
      const same = yield* Effect.all(
        Array.from({ length: 10 }, () => secrets.createRequest(requestInput("SAME_KEY"))),
        { concurrency: "unbounded" },
      );
      assert.equal(new Set(same.map((result) => result.requestId)).size, 1);
      const count = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM workbench_agent_secret_requests
        WHERE agent_id = 'agent-a' AND name = 'SAME_KEY' AND status = 'pending'
      `;
      assert.equal(count[0]?.n, 1);

      const many = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          Effect.result(secrets.createRequest(requestInput(`PARALLEL_${index}`))),
        ),
        { concurrency: "unbounded" },
      );
      const accepted = many.filter((result) => result._tag === "Success").length;
      // SAME_KEY already holds one of the five slots.
      assert.equal(accepted, AGENT_SECRET_MAX_PENDING_PER_AGENT - 1);
      const total = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM workbench_agent_secret_requests
        WHERE agent_id = 'agent-a' AND status = 'pending'
      `;
      assert.equal(total[0]?.n, AGENT_SECRET_MAX_PENDING_PER_AGENT);
    }),
  ),
);

it.effect("after the owner declines, the same name cannot be asked for again for ten minutes", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgents;
      const secrets = yield* AgentSecrets.AgentSecrets;
      const asked = yield* secrets.createRequest(requestInput("STRIPE_API_KEY"));
      yield* secrets.decline({ requestId: asked.requestId ?? "" });
      const again = yield* failureOf(secrets.createRequest(requestInput("STRIPE_API_KEY")));
      assert.equal(again.reason, "request_declined_recently");
      // Another name is not held back.
      assert.equal((yield* secrets.createRequest(requestInput("OTHER_KEY"))).status, "requested");
      yield* TestClock.adjust(Duration.minutes(9));
      assert.equal(
        (yield* failureOf(secrets.createRequest(requestInput("STRIPE_API_KEY")))).reason,
        "request_declined_recently",
      );
      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(
        (yield* secrets.createRequest(requestInput("STRIPE_API_KEY"))).status,
        "requested",
      );
    }),
  ),
);

it.effect(
  "finding a thread's agent and its values does not decode agent documents or read files needlessly",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgents;
        const sql = yield* SqlClient.SqlClient;
        const secrets = yield* AgentSecrets.AgentSecrets;
        // A document that cannot be decoded would break any lookup that reads every agent.
        yield* sql`INSERT INTO workbench_agents (id, revision, document) VALUES ('broken', 1, 'not json')`;

        const owner = yield* secrets.agentForThread(threadA);
        assert.deepEqual(owner, { agentId: "agent-a", archived: false });
        const reads = () => Ref.get(fakes.storeReads);

        // A thread with no agent, and an agent with no secrets, read no file at all.
        assert.deepEqual(yield* secrets.valuesForThread(ThreadId.make("no-agent-thread")), []);
        assert.deepEqual(yield* secrets.valuesForThread(threadA), []);
        assert.equal(yield* reads(), 0);

        yield* secrets.set(secretInput());
        const values = yield* secrets.valuesForThread(threadA);
        assert.deepEqual(
          values.map((value) => Redacted.value(value)),
          [VALUE],
        );
        assert.equal(yield* reads(), 1);
        // The other agent still reads nothing.
        assert.deepEqual(yield* secrets.valuesForThread(threadB), []);
        assert.equal(yield* reads(), 1);
      }),
    ),
);
