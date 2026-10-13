import { assert, it } from "@effect/vitest";
import {
  AgentGoalError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type WorkbenchAgentGoal,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as AgentGoals from "../agents/AgentGoals.ts";
import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentGoalsMcpService from "./AgentGoalsMcpService.ts";
import { restrictScope } from "./AgentToolAccess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const everyDay = { type: "interval", everyMs: 86_400_000 } as const;

const goal = (id: string): WorkbenchAgentGoal => ({
  id,
  title: `Goal ${id}`,
  outcome: "Done.",
  schedule: {
    ...everyDay,
    // Decoded schedules carry no extra fields; the cast keeps the fixture small.
  } as WorkbenchAgentGoal["schedule"],
  autonomy: "act_and_report",
  status: "active",
  scheduledTaskId: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
});

const makeAgent = (id: string, primary: string, goals: ReadonlyArray<WorkbenchAgentGoal>) =>
  ({
    profile: { id, name: id },
    revision: 1,
    primaryThreadId: primary,
    goals,
  }) as unknown as WorkspaceAgent;

const ownerAgent = makeAgent("agent-own", "thread-own", [goal("goal-own")]);
const otherAgent = makeAgent("agent-other", "thread-other", [goal("goal-other")]);

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

type Call = { readonly method: string; readonly input: unknown; readonly options?: unknown };

const harness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
  const record = (method: string, input: unknown, options?: unknown) =>
    Ref.update(calls, (all) => [...all, { method, input, options }]);
  const goalsLayer = Layer.mock(AgentGoals.AgentGoals)({
    upsertGoal: (input) =>
      record("upsertGoal", input).pipe(Effect.as({ agent: ownerAgent, goal: goal("goal-own") })),
    // Stands in for the real rule, which `AgentGoals.test.ts` covers: an agent may not resume.
    setStatus: (input, options) =>
      record("setStatus", input, options).pipe(
        Effect.andThen(
          input.status === "active" && options?.byAgent === true
            ? Effect.fail(new AgentGoalError({ reason: "owner_only_resume" }))
            : Effect.succeed({ agent: ownerAgent, goal: goal("goal-own") }),
        ),
      ),
    fileCheckIn: (input) =>
      record("fileCheckIn", input).pipe(
        Effect.as({ checkIn: { id: "checkin-1" } as never, goal: goal("goal-own") }),
      ),
  });
  const agentsLayer = Layer.mock(AgentWorkspace.AgentWorkspace)({
    list: Effect.succeed([ownerAgent, otherAgent]),
  });
  const threadsLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.succeed({
        runs: [
          { id: "run-old", ordinal: 1, status: "completed" },
          { id: "run-live", ordinal: 2, status: "running" },
        ],
      } as never),
  });
  const service = yield* AgentGoalsMcpService.AgentGoalsMcpService.pipe(
    Effect.provide(
      AgentGoalsMcpService.layer.pipe(
        Layer.provide(Layer.mergeAll(goalsLayer, agentsLayer, threadsLayer)),
      ),
    ),
  );
  return { service, calls };
});

it.effect("lists and edits only the goals of the agent that owns the calling thread", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* harness;
    const listed = yield* service.list(scopeFor("thread-own"));
    assert.equal(listed.agentId, "agent-own");
    assert.deepEqual(
      listed.goals.map((entry) => entry.id),
      ["goal-own"],
    );

    // The same call from the other agent's thread sees that agent's goals, not the first one's.
    const other = yield* service.list(scopeFor("thread-other"));
    assert.equal(other.agentId, "agent-other");

    yield* service.set(scopeFor("thread-own"), {
      title: "Title",
      outcome: "Outcome",
      schedule: everyDay,
    });
    yield* service.setStatus(scopeFor("thread-own"), { goalId: "goal-own", status: "paused" });
    const recorded = yield* Ref.get(calls);
    assert.deepEqual(
      recorded.map((call) => [call.method, (call.input as { agentId: string }).agentId]),
      [
        ["upsertGoal", "agent-own"],
        ["setStatus", "agent-own"],
      ],
    );
  }),
);

it.effect("keeps an edit's autonomy and defaults a new goal to propose", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* harness;
    const base = { title: "Title", outcome: "Outcome", schedule: everyDay } as const;
    yield* service.set(scopeFor("thread-own"), base);
    yield* service.set(scopeFor("thread-own"), { ...base, goalId: "goal-own" });
    const autonomies = (yield* Ref.get(calls)).map(
      (call) => (call.input as { autonomy: string }).autonomy,
    );
    assert.deepEqual(autonomies, ["propose", "act_and_report"]);
  }),
);

it.effect(
  "refuses a check-in for a goal the calling agent does not own, and says it is missing",
  () =>
    Effect.gen(function* () {
      const { service, calls } = yield* harness;
      const denied = yield* Effect.flip(
        service.reportCheckIn(scopeFor("thread-own"), { goalId: "goal-other", summary: "Sneaky" }),
      );
      assert.equal(denied.code, "invalid_request");
      assert.include(denied.message, "goal not found");
      assert.deepEqual(yield* Ref.get(calls), []);

      const filed = yield* service.reportCheckIn(scopeFor("thread-own"), {
        goalId: "goal-own",
        summary: "Done for today",
        done: true,
      });
      assert.equal(filed.checkInId, "checkin-1");
      const [call] = yield* Ref.get(calls);
      assert.deepEqual(call?.input, {
        goalId: "goal-own",
        threadId: "thread-own",
        runId: "run-live",
        summary: "Done for today",
        needsFromOwner: null,
        done: true,
      });
    }),
);

it.effect("rejects threads with no agent and credentials without orchestration", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* harness;
    const stranger = yield* Effect.flip(service.list(scopeFor("thread-stranger")));
    assert.equal(stranger.code, "invalid_request");
    const noCapability = yield* Effect.flip(service.list(scopeFor("thread-own", [])));
    assert.equal(noCapability.code, "capability_denied");
    const noWrite = yield* Effect.flip(
      service.setStatus(scopeFor("thread-stranger"), { goalId: "goal-own", status: "done" }),
    );
    assert.equal(noWrite.code, "invalid_request");
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);

it.effect("an agent may pause or finish a goal but not resume it", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* harness;
    const scope = scopeFor("thread-own");
    yield* service.setStatus(scope, { goalId: "goal-own", status: "paused" });
    yield* service.setStatus(scope, { goalId: "goal-own", status: "done" });
    const denied = yield* Effect.flip(
      service.setStatus(scope, { goalId: "goal-own", status: "active" }),
    );
    assert.equal(denied.code, "invalid_request");
    assert.equal(denied.message, "Only the owner can resume a goal.");
    // Every status change from a tool is marked as the agent's own, so the service can refuse a resume.
    const recorded = yield* Ref.get(calls);
    assert.deepEqual(
      recorded.map((call) => call.options),
      [{ byAgent: true }, { byAgent: true }, { byAgent: true }],
    );
  }),
);

it.effect("goal tools and check-ins still work when Other Conversations is switched off", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* harness;
    // What the middleware hands a call once the agent's owner switched the group off.
    const scope = restrictScope(scopeFor("thread-own"), ["orchestration"]);
    assert.isFalse(scope.capabilities.has("orchestration"));

    const listed = yield* service.list(scope);
    assert.deepEqual(
      listed.goals.map((entry) => entry.id),
      ["goal-own"],
    );
    yield* service.set(scope, { title: "Title", outcome: "Outcome", schedule: everyDay });
    yield* service.setStatus(scope, { goalId: "goal-own", status: "paused" });
    const filed = yield* service.reportCheckIn(scope, {
      goalId: "goal-own",
      summary: "Done for today",
    });
    assert.equal(filed.checkInId, "checkin-1");
    assert.deepEqual(
      (yield* Ref.get(calls)).map((call) => call.method),
      ["upsertGoal", "setStatus", "fileCheckIn"],
    );

    // A credential that never held orchestration is still refused, switch or no switch.
    const never = yield* Effect.flip(service.list(restrictScope(scopeFor("thread-own", []), [])));
    assert.equal(never.code, "capability_denied");
  }),
);
