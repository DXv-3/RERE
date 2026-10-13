import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  MessageId,
  ThreadId,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";

import * as AgentReplies from "../agents/AgentReplies.ts";
import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentTeamMcpService from "./AgentTeamMcpService.ts";
import { restrictScope } from "./AgentToolAccess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const makeAgent = (
  id: string,
  name: string,
  primary: string | null,
  extra: Record<string, unknown> = {},
) =>
  ({
    profile: {
      id,
      name,
      description: `${name} role`,
      instructions: "Secret instructions.",
      projectKey: "",
      runtimeMode: "inherit",
      modelSelection: null,
    },
    recovery: { disposition: "ready", blockers: [] },
    revision: 1,
    primaryThreadId: primary,
    ...extra,
  }) as unknown as WorkspaceAgent;

const agents = [
  makeAgent("a", "Alpha", "thread-a", {
    goals: [{ id: "g1", title: "Weekly sweep", status: "active" }],
  }),
  makeAgent("b", "Beta", "thread-b"),
  makeAgent("c", "Gamma", "thread-c"),
  makeAgent("d", "Delta", "thread-d"),
  makeAgent("e", "Epsilon", "thread-e"),
  makeAgent("n", "Newbie", null),
  makeAgent("t1", "Twin", "thread-t1"),
  makeAgent("t2", "twin", "thread-t2"),
  makeAgent("z", "Retired", "thread-z", { archivedAt: "2026-10-01T00:00:00.000Z" }),
];

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

/** Who sent the user message that started the thread's live run; absent means a person did. */
type Starters = Readonly<Record<string, string | undefined>>;

/** Threads whose live run was started by an automatic reply: who sent it, and the depth it carries. */
type ReplyStarters = Readonly<Record<string, { readonly sender: string; readonly hops: number }>>;

const harness = (
  starters: Starters = {},
  shells: Record<string, unknown> = {},
  replyStarters: ReplyStarters = {},
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const requested = yield* Ref.make<ReadonlyArray<AgentReplies.AgentReplyRequest>>([]);
    const settled = yield* Ref.make<ReadonlyArray<string>>([]);
    const prepared = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
    const records = yield* Ref.make(agents);
    const repliesLayer = Layer.mock(AgentReplies.AgentReplies)({
      request: (input) => Ref.update(requested, (all) => [...all, input]).pipe(Effect.as(true)),
      settleRecipient: (threadId) =>
        Ref.update(settled, (all) => [...all, threadId]).pipe(Effect.as(0)),
      hopsOfReply: (messageId) =>
        Effect.succeed(
          Object.entries(replyStarters).find(
            ([threadId]) => messageId === `agent-reply:source-${threadId}`,
          )?.[1].hops ?? null,
        ),
    });
    const agentsLayer = Layer.mock(AgentWorkspace.AgentWorkspace)({
      list: Ref.get(records),
      read: (id) =>
        Ref.get(records).pipe(Effect.map((all) => all.find((agent) => agent.profile.id === id)!)),
      save: ({ agent, expectedRevision }) => {
        const saved = { ...agent, revision: expectedRevision + 1 };
        return Ref.update(records, (all) =>
          all.some((item) => item.profile.id === agent.profile.id)
            ? all.map((item) => (item.profile.id === agent.profile.id ? saved : item))
            : [...all, saved],
        ).pipe(Effect.as(saved));
      },
    });
    const launchLayer = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Ref.update(prepared, (all) => [...all, input]).pipe(
          Effect.as({ threadId: input.threadId, projection: {}, resumed: false } as never),
        ),
    });
    const foldersLayer = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
    });
    const projectsLayer = Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeed(Option.none()),
    });
    const threadsLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadProjection: () =>
        Effect.succeed({
          thread: {
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
          },
        } as never),
      getThreadShell: (threadId) => Effect.succeed((shells[threadId] ?? null) as never),
      getThreadRecords: (threadId) => {
        const sender = starters[threadId];
        const reply = replyStarters[threadId];
        return Effect.succeed({
          runs: [{ id: `run-${threadId}`, ordinal: 1, status: "running" }],
          messages: [
            {
              id: `message-old-${threadId}`,
              runId: `run-old-${threadId}`,
              role: "user",
              createdBy: "agent",
              senderThreadId: "thread-ancient",
              createdAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
            },
            reply === undefined
              ? {
                  id: `message-${threadId}`,
                  runId: `run-${threadId}`,
                  role: "user",
                  createdBy: sender === undefined ? "user" : "agent",
                  ...(sender === undefined ? {} : { senderThreadId: sender }),
                  createdAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
                }
              : {
                  id: `agent-reply:source-${threadId}`,
                  runId: `run-${threadId}`,
                  role: "user",
                  createdBy: "agent",
                  senderThreadId: reply.sender,
                  createdAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
                },
          ],
        } as never);
      },
    });
    const orchestratorLayer = Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      sendToThread: (scope, input) =>
        Ref.update(sent, (all) => [...all, { scope, input }]).pipe(
          Effect.as({
            threadId: input.threadId,
            messageId: MessageId.make("message:sent"),
            runId: RunId.make("run:sent"),
            status: "running" as const,
            delivery: "started" as const,
          }),
        ),
    });
    const service = yield* AgentTeamMcpService.AgentTeamMcpService.pipe(
      Effect.provide(
        AgentTeamMcpService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              agentsLayer,
              threadsLayer,
              orchestratorLayer,
              repliesLayer,
              launchLayer,
              foldersLayer,
              projectsLayer,
            ),
          ),
        ),
      ),
    );
    return { service, sent, requested, settled, prepared, records };
  });

it.effect("lists live agents with a bounded role, status and goal, and marks the caller", () =>
  Effect.gen(function* () {
    const { service } = yield* harness(
      {},
      {
        "thread-b": { status: "running", activeRunId: "run-1", pendingRuntimeRequest: null },
        "thread-c": { status: "waiting", activeRunId: "run-2", pendingRuntimeRequest: {} },
        "thread-d": { status: "failed", activeRunId: null, pendingRuntimeRequest: null },
      },
    );
    const { agents: listed } = yield* service.list(scopeFor("thread-a"));
    const byId = new Map(listed.map((entry) => [entry.agentId, entry]));
    assert.isFalse(byId.has("z"), "archived agents are left out");
    assert.equal(byId.get("a")?.isYou, true);
    assert.equal(byId.get("b")?.isYou, false);
    assert.equal(byId.get("a")?.currentGoal, "Weekly sweep");
    assert.equal(byId.get("a")?.status, "idle");
    assert.equal(byId.get("b")?.status, "working");
    assert.equal(byId.get("c")?.status, "needs_input");
    assert.equal(byId.get("d")?.status, "failed");
    assert.equal(byId.get("n")?.status, "not_started");
    assert.equal(byId.get("n")?.threadId, null);
    assert.equal(byId.get("b")?.role, "Beta role");
    assert.isFalse(
      listed.some((entry) =>
        Object.values(entry).some((value) => String(value).includes("Secret instructions")),
      ),
    );
  }),
);

it.effect("delivers to the recipient's own conversation through the thread send path", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* harness();
    const scope = scopeFor("thread-a");
    const result = yield* service.send(scope, {
      agent: "  BETA ",
      message: "Please check the build.",
      mode: "queue",
      clientRequestId: "req-1",
    });
    assert.equal(result.agentId, "b");
    assert.equal(result.agentName, "Beta");
    assert.equal(result.threadId, "thread-b");
    assert.equal(result.delivery, "started");
    assert.equal(result.hops, 1);
    const [call] = (yield* Ref.get(sent)) as ReadonlyArray<{
      scope: McpInvocationScope;
      input: Record<string, unknown>;
    }>;
    // The caller's own scope is passed through, which is what records the sending thread.
    assert.strictEqual(call?.scope, scope);
    assert.equal(call?.input.threadId, "thread-b");
    assert.equal(call?.input.mode, "queue");
    assert.equal(call?.input.clientRequestId, "req-1");
    assert.include(String(call?.input.message), "Message from agent Alpha (id a)");
    assert.include(String(call?.input.message), "Please check the build.");
  }),
);

it.effect("refuses an unknown name with the closest matches, and an ambiguous one with ids", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* harness();
    const unknown = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "Zebra", message: "hi" }),
    );
    assert.equal(unknown.code, "invalid_request");
    const typo = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "Gama", message: "hi" }),
    );
    assert.include(typo.message, "Did you mean: Gamma (c)");
    const ambiguous = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "TWIN", message: "hi" }),
    );
    assert.include(ambiguous.message, "Twin (t1)");
    assert.include(ambiguous.message, "twin (t2)");
    const archived = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "Retired", message: "hi" }),
    );
    assert.equal(archived.code, "invalid_request");
    assert.deepEqual(yield* Ref.get(sent), []);
  }),
);

it.effect("refuses to message itself, by name or by id", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* harness();
    for (const agent of ["Alpha", "a"]) {
      const self = yield* Effect.flip(
        service.send(scopeFor("thread-a"), { agent, message: "hi me" }),
      );
      assert.include(self.message, "cannot send a message to itself");
    }
    assert.deepEqual(yield* Ref.get(sent), []);
  }),
);

it.effect("prepares and binds a personal conversation before starting an unopened teammate", () =>
  Effect.gen(function* () {
    const { service, prepared, records, sent } = yield* harness();
    const result = yield* service.send(scopeFor("thread-a"), {
      agent: "Newbie",
      message: "Check this.",
    });
    assert.equal(result.threadId, "agent:n");
    const [launch] = yield* Ref.get(prepared);
    assert.equal(launch?.prepareOnly, true);
    assert.equal(launch?.initialMessage, undefined);
    assert.equal(launch?.projectId, "scratch");
    assert.equal(launch?.modelSelection.model, "gpt-6.1-sol");
    assert.equal(
      (yield* Ref.get(records)).find((agent) => agent.profile.id === "n")?.primaryThreadId,
      "agent:n",
    );
    yield* service.send(scopeFor("thread-a"), { agent: "Newbie", message: "Follow up." });
    assert.equal((yield* Ref.get(prepared)).length, 1);
    assert.equal((yield* Ref.get(sent)).length, 2);
  }),
);

it.effect("does not activate an imported agent awaiting recovery", () =>
  Effect.gen(function* () {
    const { service, prepared, records, sent } = yield* harness();
    yield* Ref.update(records, (all) =>
      all.map((agent) =>
        agent.profile.id === "n"
          ? { ...agent, recovery: { ...agent.recovery, disposition: "blocked" as const } }
          : agent,
      ),
    );
    const error = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "Newbie", message: "Check this." }),
    );
    assert.equal(error.code, "thread_not_sendable");
    assert.deepEqual(yield* Ref.get(prepared), []);
    assert.deepEqual(yield* Ref.get(sent), []);
  }),
);

it.effect("creates one persistent teammate, starts its assignment, and reuses it on a retry", () =>
  Effect.gen(function* () {
    const { service, records, prepared, sent } = yield* harness();
    const input = {
      name: "Certifications",
      description: "Course specialist",
      instructions: "Own the assigned coursework.",
      message: "Review the remaining Python lessons.",
      clientRequestId: "create-course-1",
    };
    const first = yield* service.create(scopeFor("thread-a"), input);
    assert.equal(first.created, true);
    assert.equal(first.replyExpected, true);
    const again = yield* service.create(scopeFor("thread-a"), input);
    assert.equal(again.agentId, first.agentId);
    assert.equal(again.created, false);
    assert.equal(
      (yield* Ref.get(records)).filter((agent) => agent.profile.name === "Certifications").length,
      1,
    );
    assert.equal((yield* Ref.get(prepared)).length, 1);
    assert.equal(
      (yield* Ref.get(sent)).length,
      2,
      "both dispatches carry the same idempotency key",
    );
    const error = yield* Effect.flip(
      service.create(scopeFor("thread-a"), { ...input, instructions: "Changed role" }),
    );
    assert.equal(error.code, "invalid_request");
    assert.equal((yield* Ref.get(sent)).length, 2);
  }),
);

it.effect("does not create a teammate when Other Conversations is switched off", () =>
  Effect.gen(function* () {
    const { service, records, prepared } = yield* harness();
    const error = yield* Effect.flip(
      service.create(restrictScope(scopeFor("thread-a"), ["orchestration"]), {
        name: "Helper",
        description: "",
        instructions: "Help.",
        message: "Review.",
        clientRequestId: "no-access",
      }),
    );
    assert.equal(error.code, "capability_denied");
    assert.equal((yield* Ref.get(records)).length, agents.length);
    assert.deepEqual(yield* Ref.get(prepared), []);
  }),
);

it.effect("cuts a chain of agent messages off after three hops", () =>
  Effect.gen(function* () {
    // a was started by a person; b by a; c by b; d by c: d is already three hops deep.
    const chain: Starters = {
      "thread-a": undefined,
      "thread-b": "thread-a",
      "thread-c": "thread-b",
      "thread-d": "thread-c",
    };
    const { service, sent } = yield* harness(chain);
    const fromC = yield* service.send(scopeFor("thread-c"), { agent: "Epsilon", message: "ok" });
    assert.equal(fromC.hops, 3, "two hops deep may still pass it on, making the third");
    const fromD = yield* Effect.flip(
      service.send(scopeFor("thread-d"), { agent: "Epsilon", message: "one too many" }),
    );
    assert.equal(fromD.code, "invalid_request");
    assert.include(fromD.message, "3 agent messages deep");
    assert.equal((yield* Ref.get(sent)).length, 1);
  }),
);

it.effect("stops a loop between two agents rather than following it forever", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* harness({ "thread-a": "thread-b", "thread-b": "thread-a" });
    const refused = yield* Effect.flip(
      service.send(scopeFor("thread-a"), { agent: "Gamma", message: "again" }),
    );
    assert.equal(refused.code, "invalid_request");
    assert.deepEqual(yield* Ref.get(sent), []);
  }),
);

it.effect("only counts messages that started the live run, not older agent messages", () =>
  Effect.gen(function* () {
    // The fixture also carries an old agent message in an earlier run; it must not count.
    const { service } = yield* harness({});
    const result = yield* service.send(scopeFor("thread-a"), { agent: "Beta", message: "hi" });
    assert.equal(result.hops, 1);
  }),
);

it.effect("is refused when the owner switched Other Conversations off for the agent", () =>
  Effect.gen(function* () {
    const { service, sent } = yield* harness();
    const switchedOff = restrictScope(scopeFor("thread-a"), ["orchestration"]);
    const listDenied = yield* Effect.flip(service.list(switchedOff));
    assert.equal(listDenied.code, "capability_denied");
    assert.include(listDenied.message, "Other Conversations access is switched off");
    const sendDenied = yield* Effect.flip(
      service.send(switchedOff, { agent: "Beta", message: "hi" }),
    );
    assert.equal(sendDenied.code, "capability_denied");
    assert.include(sendDenied.message, "switched off");
    const noCapability = yield* Effect.flip(
      service.send(scopeFor("thread-a", []), { agent: "Beta", message: "hi" }),
    );
    assert.equal(noCapability.code, "capability_denied");
    assert.deepEqual(yield* Ref.get(sent), []);
  }),
);

it.effect("asks for the answer back by default and tells the recipient it will be sent on", () =>
  Effect.gen(function* () {
    const { service, sent, requested, settled } = yield* harness();
    const result = yield* service.send(scopeFor("thread-a"), {
      agent: "Beta",
      message: "Check it.",
    });
    assert.equal(result.replyExpected, true);
    assert.deepEqual(yield* Ref.get(requested), [
      {
        sourceMessageId: MessageId.make("message:sent"),
        recipientThreadId: ThreadId.make("thread-b"),
        recipientName: "Beta",
        askerThreadId: ThreadId.make("thread-a"),
        hops: 1,
      },
    ]);
    assert.deepEqual(
      yield* Ref.get(settled),
      ["thread-b"],
      "a run that settled before the row was written is looked at once",
    );
    const [call] = (yield* Ref.get(sent)) as ReadonlyArray<{ input: Record<string, unknown> }>;
    const text = String(call?.input.message);
    assert.include(text, "sent back to them automatically");
    assert.notInclude(text, "reply with agent_send");
  }),
);

it.effect("records nothing and says no reply is expected when awaitReply is false", () =>
  Effect.gen(function* () {
    const { service, sent, requested, settled } = yield* harness();
    const result = yield* service.send(scopeFor("thread-a"), {
      agent: "Beta",
      message: "FYI.",
      awaitReply: false,
    });
    assert.equal(result.replyExpected, false);
    assert.deepEqual(yield* Ref.get(requested), []);
    assert.deepEqual(yield* Ref.get(settled), []);
    const [call] = (yield* Ref.get(sent)) as ReadonlyArray<{ input: Record<string, unknown> }>;
    assert.include(String(call?.input.message), "no reply is expected");
  }),
);

it.effect("counts an automatic reply at the depth of the ask it answers, not as a fresh hop", () =>
  Effect.gen(function* () {
    // a's live run was started by b's automatic reply to an ask that was one hop deep.
    const afterReply = yield* harness({}, {}, { "thread-a": { sender: "thread-b", hops: 1 } });
    const next = yield* afterReply.service.send(scopeFor("thread-a"), {
      agent: "Gamma",
      message: "next",
    });
    assert.equal(next.hops, 2, "the reply did not lock the asker out");
    assert.equal(next.replyExpected, true);

    // The same reply at the cap ends the chain, so two agents cannot trade work forever.
    const atCap = yield* harness({}, {}, { "thread-a": { sender: "thread-b", hops: 3 } });
    const refused = yield* Effect.flip(
      atCap.service.send(scopeFor("thread-a"), { agent: "Gamma", message: "again" }),
    );
    assert.include(refused.message, "3 agent messages deep");
    assert.deepEqual(yield* Ref.get(atCap.requested), []);
  }),
);
