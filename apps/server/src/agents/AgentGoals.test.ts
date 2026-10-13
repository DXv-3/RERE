import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type AgentGoalUpsertInput,
  type OrchestrationV2Run,
  type ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type WorkspaceAgent,
  agentGoalTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as AgentGoalFallback from "./AgentGoalFallback.ts";
import * as AgentGoals from "./AgentGoals.ts";
import * as AgentWorkspace from "./AgentWorkspace.ts";

const agentThread = ThreadId.make("agent-thread");
const projectId = "project-1" as ProjectId;
const shell = {
  projectId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
} as const;
const everyDay = { type: "interval", everyMs: 86_400_000 } as const;

const agent: WorkspaceAgent = {
  profile: {
    id: "agent-1",
    name: "Ops",
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
  primaryThreadId: agentThread,
  updatedAt: "2026-10-04T00:00:00.000Z",
};

const goalInput = (overrides: Partial<AgentGoalUpsertInput> = {}): AgentGoalUpsertInput => ({
  agentId: "agent-1",
  title: "Keep the inbox clear",
  outcome: "No unanswered client email older than a day.",
  schedule: everyDay,
  autonomy: "propose",
  ...overrides,
});

interface FakeMessage {
  readonly id: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly scheduledTaskId?: string;
}

type SentMessage = Parameters<
  ThreadManagementService.ThreadManagementServiceShape["sendToThread"]
>[0];

interface Fakes {
  readonly sent: Ref.Ref<ReadonlyArray<SentMessage>>;
  readonly messages: Ref.Ref<ReadonlyArray<FakeMessage>>;
  readonly events: ReadonlyArray<unknown>;
}

/** Real stores and scheduled-task service; only the orchestrator-facing thread service is faked. */
const makeLayer = (fakes: Fakes) => {
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(shell as never),
    sendToThread: (input) =>
      Ref.update(fakes.sent, (all) => [...all, input]).pipe(Effect.as({} as never)),
    getThreadRecords: (_threadId: unknown, _fields: unknown, filter?: unknown) =>
      Ref.get(fakes.messages).pipe(
        Effect.map((messages) => {
          const f = (filter ?? {}) as {
            messageIds?: ReadonlyArray<string>;
            messageRunIds?: ReadonlyArray<string>;
            messageRoles?: ReadonlyArray<string>;
          };
          return {
            messages: messages.filter(
              (m) =>
                (f.messageIds === undefined || f.messageIds.includes(m.id)) &&
                (f.messageRunIds === undefined ||
                  (m.runId !== null && f.messageRunIds.includes(m.runId))) &&
                (f.messageRoles === undefined || f.messageRoles.includes(m.role)),
            ),
          } as never;
        }),
      ),
    streamDomainEvents: Stream.fromIterable(fakes.events) as never,
  });
  const base = Layer.mergeAll(
    AgentWorkspace.layer,
    threads,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    NodeCrypto.layer,
    Scheduler.layer,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
  return AgentGoalFallback.layer.pipe(
    Layer.provideMerge(AgentGoals.layer),
    Layer.provideMerge(ScheduledTaskService.layer),
    Layer.provideMerge(base),
  );
};

const makeFakes = (events: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    return {
      sent: yield* Ref.make<ReadonlyArray<SentMessage>>([]),
      messages: yield* Ref.make<ReadonlyArray<FakeMessage>>([]),
      events,
    } satisfies Fakes;
  });

const withHarness = <A, E>(
  body: (
    fakes: Fakes,
  ) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeLayer>> | Scope.Scope>,
  events: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    const fakes = yield* makeFakes(events);
    return yield* Effect.scoped(body(fakes).pipe(Effect.provide(makeLayer(fakes))));
  });

const seedAgent = Effect.gen(function* () {
  const workspace = yield* AgentWorkspace.AgentWorkspace;
  return yield* workspace.save({ agent, expectedRevision: 0 });
});

const taskFor = (goalId: string) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTaskService.ScheduledTaskService;
    const { tasks: all } = yield* tasks.list();
    return all.find((task) => task.id === agentGoalTaskId(goalId));
  });

const fileN = (goalId: string, count: number) =>
  Effect.gen(function* () {
    const goals = yield* AgentGoals.AgentGoals;
    for (let i = 0; i < count; i++) {
      yield* goals.fileCheckIn({
        goalId,
        threadId: agentThread,
        runId: RunId.make(`run-${i}`),
        summary: `Check-in ${i}`,
      });
    }
  });

it.effect(
  "upsertGoal creates one scheduled task bound to the primary thread, then edits it in place",
  () =>
    withHarness(() =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const created = yield* goals.upsertGoal(goalInput());
        const goal = created.goal;
        assert.equal(goal.status, "active");
        assert.equal(goal.scheduledTaskId, agentGoalTaskId(goal.id));
        assert.equal(created.agent.goals?.length, 1);
        assert.equal(created.agent.revision, 2);

        const task = yield* taskFor(goal.id);
        assert.isDefined(task);
        assert.equal(task?.enabled, true);
        assert.equal(task?.threadId, agentThread);
        assert.equal(task?.projectId, projectId);
        assert.include(task?.prompt ?? "", "Goal: Keep the inbox clear");
        assert.include(task?.prompt ?? "", `goalId "${goal.id}"`);

        const edited = yield* goals.upsertGoal(
          goalInput({
            goalId: goal.id,
            title: "Keep the inbox empty",
            schedule: { type: "fixed_time", timeOfDay: "09:00" },
            autonomy: "act_and_report",
          }),
        );
        assert.equal(edited.goal.id, goal.id);
        assert.equal(edited.goal.createdAt, goal.createdAt);
        assert.equal(edited.agent.goals?.length, 1);
        const updated = yield* taskFor(goal.id);
        assert.equal(updated?.title, "Keep the inbox empty");
        assert.deepEqual(updated?.schedule, { type: "fixed_time", timeOfDay: "09:00" });
        assert.include(updated?.prompt ?? "", "within your normal permissions");
        const tasks = yield* (yield* ScheduledTaskService.ScheduledTaskService).list();
        assert.equal(tasks.tasks.length, 1);
      }),
    ),
);

it.effect("upsertGoal refuses archived agents, agents without a thread, and unknown goals", () =>
  withHarness(() =>
    Effect.gen(function* () {
      const workspace = yield* AgentWorkspace.AgentWorkspace;
      const goals = yield* AgentGoals.AgentGoals;
      const saved = yield* seedAgent;
      assert.equal(
        (yield* Effect.flip(goals.upsertGoal(goalInput({ agentId: "nope" })))).reason,
        "agent_not_found",
      );
      assert.equal(
        (yield* Effect.flip(goals.upsertGoal(goalInput({ goalId: "missing" })))).reason,
        "goal_not_found",
      );
      const noThread = yield* workspace.save({
        agent: { ...saved, primaryThreadId: null },
        expectedRevision: saved.revision,
      });
      assert.equal((yield* Effect.flip(goals.upsertGoal(goalInput()))).reason, "no_primary_thread");
      yield* workspace.save({
        agent: {
          ...noThread,
          primaryThreadId: agentThread,
          archivedAt: "2026-10-04T00:00:00.000Z",
        },
        expectedRevision: noThread.revision,
      });
      assert.equal((yield* Effect.flip(goals.upsertGoal(goalInput()))).reason, "agent_archived");
      assert.isUndefined(yield* taskFor("anything"));
    }),
  ),
);

it.effect("pause, resume, done, and delete drive the scheduled task", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());

      const paused = yield* goals.setStatus({
        agentId: "agent-1",
        goalId: goal.id,
        status: "paused",
      });
      assert.equal(paused.goal.pausedReason, "owner");
      assert.equal((yield* taskFor(goal.id))?.enabled, false);

      const resumed = yield* goals.setStatus({
        agentId: "agent-1",
        goalId: goal.id,
        status: "active",
      });
      assert.isUndefined(resumed.goal.pausedReason);
      assert.equal((yield* taskFor(goal.id))?.enabled, true);

      const done = yield* goals.setStatus({ agentId: "agent-1", goalId: goal.id, status: "done" });
      assert.equal(done.goal.status, "done");
      assert.equal((yield* taskFor(goal.id))?.enabled, false);

      const removed = yield* goals.deleteGoal({ agentId: "agent-1", goalId: goal.id });
      assert.equal(removed.agent.goals?.length, 0);
      assert.isUndefined(yield* taskFor(goal.id));
      assert.equal(
        (yield* Effect.flip(goals.deleteGoal({ agentId: "agent-1", goalId: goal.id }))).reason,
        "goal_not_found",
      );
    }),
  ),
);

it.effect("an agent cannot resume a goal, and editing a paused goal leaves it paused", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());
      const byAgent = { byAgent: true } as const;
      const ref = { agentId: "agent-1", goalId: goal.id } as const;

      // Active on an active goal changes nothing; pausing is allowed.
      assert.equal(
        (yield* goals.setStatus({ ...ref, status: "active" }, byAgent)).goal.status,
        "active",
      );
      yield* goals.setStatus({ ...ref, status: "paused" }, byAgent);
      assert.equal(
        (yield* Effect.flip(goals.setStatus({ ...ref, status: "active" }, byAgent))).reason,
        "owner_only_resume",
      );
      assert.equal((yield* goals.findGoal(goal.id)).goal.status, "paused");

      // Editing through upsert (the goal_set path) keeps the pause and the stopped task.
      const edited = yield* goals.upsertGoal(goalInput({ goalId: goal.id, title: "Renamed" }));
      assert.equal(edited.goal.status, "paused");
      assert.equal(edited.goal.pausedReason, "owner");
      assert.equal((yield* taskFor(goal.id))?.enabled, false);

      // A done goal is no different, and the owner (no flag) can still resume.
      yield* goals.setStatus({ ...ref, status: "done" }, byAgent);
      assert.equal(
        (yield* Effect.flip(goals.setStatus({ ...ref, status: "active" }, byAgent))).reason,
        "owner_only_resume",
      );
      assert.equal((yield* goals.setStatus({ ...ref, status: "active" })).goal.status, "active");
      assert.equal((yield* taskFor(goal.id))?.enabled, true);
    }),
  ),
);

it.effect("a client save of the agent keeps its goals and their scheduled tasks", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const workspace = yield* AgentWorkspace.AgentWorkspace;
      const { goal, agent: withGoal } = yield* goals.upsertGoal(goalInput());
      // What a client holding another machine's copy would send: no goals at all.
      const fromClient = yield* workspace.save({
        agent: { ...withGoal, goals: undefined },
        expectedRevision: withGoal.revision,
      });
      assert.deepEqual(
        fromClient.goals?.map((entry) => entry.id),
        [goal.id],
      );
      assert.equal((yield* goals.findGoal(goal.id)).goal.id, goal.id);
      assert.equal((yield* taskFor(goal.id))?.enabled, true);
    }),
  ),
);

it.effect(
  "an archived agent's goal task stops, and the owner turns it back on after un-archiving",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const workspace = yield* AgentWorkspace.AgentWorkspace;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const { goal, agent: live } = yield* goals.upsertGoal(goalInput());
        const taskId = agentGoalTaskId(goal.id);

        const archived = yield* workspace.save({
          agent: { ...live, archivedAt: "2026-10-05T00:00:00.000Z" },
          expectedRevision: live.revision,
        });
        // Archiving does not touch the task; the guard stops it when it is about to fire.
        assert.equal((yield* taskFor(goal.id))?.enabled, true);
        const refused = yield* Effect.flip(tasks.runNow({ id: taskId }));
        assert.equal(refused.message, "Could not run schedule task.");
        assert.equal((yield* taskFor(goal.id))?.enabled, false);
        assert.equal((yield* taskFor(goal.id))?.runCount, 0);
        assert.equal((yield* Ref.get(fakes.sent)).length, 0);

        // Un-archiving alone leaves it stopped; the owner resuming (or editing) re-enables it.
        yield* workspace.save({
          agent: { ...archived, archivedAt: null },
          expectedRevision: archived.revision,
        });
        assert.equal((yield* taskFor(goal.id))?.enabled, false);
        yield* goals.setStatus({ agentId: "agent-1", goalId: goal.id, status: "active" });
        assert.equal((yield* taskFor(goal.id))?.enabled, true);
        yield* tasks.runNow({ id: taskId });
        assert.deepEqual(
          (yield* Ref.get(fakes.sent)).map((input) => input.mode),
          ["queue"],
        );
      }),
    ),
);

it.effect(
  "a goal turn queues behind running work while an ordinary scheduled task still steers",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const tasks = yield* ScheduledTaskService.ScheduledTaskService;
        const { goal } = yield* goals.upsertGoal(goalInput());
        yield* tasks.runNow({ id: agentGoalTaskId(goal.id) });
        const ordinary = yield* tasks.upsert({
          title: "Ordinary",
          prompt: "Do the thing",
          enabled: true,
          schedule: everyDay,
          projectId,
          threadId: agentThread,
          workspaceStrategy: { type: "root" },
          modelSelection: shell.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        yield* tasks.runNow({ id: ordinary.task.id });
        const sent = yield* Ref.get(fakes.sent);
        assert.deepEqual(
          sent.map((input) => input.mode),
          ["queue", "auto"],
        );
        assert.equal(sent[0]?.scheduledTaskId, agentGoalTaskId(goal.id));
      }),
    ),
);

it.effect("filing the fifth unreviewed check-in pauses the goal until the owner resumes it", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());
      assert.equal(AgentGoals.UNREVIEWED_CHECKIN_LIMIT, 5);

      yield* fileN(goal.id, 4);
      assert.equal((yield* goals.findGoal(goal.id)).goal.status, "active");
      assert.equal((yield* taskFor(goal.id))?.enabled, true);

      yield* goals.fileCheckIn({
        goalId: goal.id,
        threadId: agentThread,
        runId: RunId.make("run-4"),
        summary: "Check-in 4",
      });
      const paused = (yield* goals.findGoal(goal.id)).goal;
      assert.equal(paused.status, "paused");
      assert.equal(paused.pausedReason, "unreviewed_limit");
      assert.equal((yield* taskFor(goal.id))?.enabled, false);

      // Reviewing back under the limit does not resume it; the owner does that.
      const page = yield* goals.listCheckIns({ goalId: goal.id });
      const first = page.checkIns[0];
      assert.isDefined(first);
      yield* goals.reviewCheckIn({ id: first!.id, action: "dismiss" });
      assert.equal((yield* goals.findGoal(goal.id)).goal.status, "paused");
      yield* goals.setStatus({ agentId: "agent-1", goalId: goal.id, status: "active" });
      assert.equal((yield* taskFor(goal.id))?.enabled, true);
    }),
  ),
);

it.effect("a check-in with done=true ends the goal, and its task stops", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());
      const filed = yield* goals.fileCheckIn({
        goalId: goal.id,
        threadId: agentThread,
        runId: RunId.make("run-1"),
        summary: "All clear.",
        needsFromOwner: "  ",
        done: true,
      });
      assert.equal(filed.goal.status, "done");
      assert.isNull(filed.checkIn.needsFromOwner);
      assert.equal((yield* taskFor(goal.id))?.enabled, false);
    }),
  ),
);

it.effect("filing again for the same run replaces a pending check-in but not a reviewed one", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());
      const input = { goalId: goal.id, threadId: agentThread, runId: RunId.make("run-1") };
      const first = yield* goals.fileCheckIn({ ...input, summary: "First draft" });
      const second = yield* goals.fileCheckIn({ ...input, summary: "Corrected" });
      assert.equal(second.checkIn.id, first.checkIn.id);
      assert.equal(second.checkIn.summary, "Corrected");
      yield* goals.reviewCheckIn({ id: first.checkIn.id, action: "approve" });
      const third = yield* goals.fileCheckIn({ ...input, summary: "Too late" });
      assert.equal(third.checkIn.summary, "Corrected");
      assert.equal((yield* goals.listCheckIns({})).checkIns.length, 1);
    }),
  ),
);

it.effect(
  "redirecting a check-in queues the owner's note as a user message and feeds the next prompt",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const { goal } = yield* goals.upsertGoal(goalInput());
        const { checkIn } = yield* goals.fileCheckIn({
          goalId: goal.id,
          threadId: agentThread,
          runId: RunId.make("run-1"),
          summary: "Found three stale emails.",
          needsFromOwner: "Which template?",
        });

        assert.equal(
          (yield* Effect.flip(goals.reviewCheckIn({ id: checkIn.id, action: "redirect" }))).reason,
          "note_required",
        );
        assert.equal((yield* Ref.get(fakes.sent)).length, 0);

        const reviewed = yield* goals.reviewCheckIn({
          id: checkIn.id,
          action: "redirect",
          note: "  Use the short template.  ",
        });
        assert.equal(reviewed.status, "redirected");
        assert.equal(reviewed.ownerNote, "Use the short template.");
        assert.isString(reviewed.reviewedAt);

        const sent = yield* Ref.get(fakes.sent);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]?.mode, "queue");
        assert.equal(sent[0]?.createdBy, "user");
        assert.equal(sent[0]?.creationSource, "server");
        assert.equal(sent[0]?.threadId, agentThread);
        assert.equal(sent[0]?.projectId, projectId);
        assert.include(sent[0]?.text ?? "", "Use the short template.");

        const prompt = (yield* taskFor(goal.id))?.prompt ?? "";
        assert.include(prompt, "Found three stale emails.");
        assert.include(prompt, "The owner's latest note: Use the short template.");

        assert.equal(
          (yield* Effect.flip(goals.reviewCheckIn({ id: checkIn.id, action: "approve" }))).reason,
          "already_reviewed",
        );
        assert.equal((yield* Ref.get(fakes.sent)).length, 1);
        assert.equal(
          (yield* Effect.flip(goals.reviewCheckIn({ id: "missing", action: "approve" }))).reason,
          "checkin_not_found",
        );
      }),
    ),
);

it.effect("lists check-ins newest first with filters and cursor pages", () =>
  withHarness(() =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const { goal } = yield* goals.upsertGoal(goalInput());
      yield* fileN(goal.id, 3);
      const all = yield* goals.listCheckIns({ agentId: "agent-1" });
      assert.deepEqual(
        all.checkIns.map((c) => c.summary),
        ["Check-in 2", "Check-in 1", "Check-in 0"],
      );
      assert.isNull(all.nextCursor);

      const firstPage = yield* goals.listCheckIns({ limit: 2 });
      assert.equal(firstPage.checkIns.length, 2);
      assert.isString(firstPage.nextCursor);
      const secondPage = yield* goals.listCheckIns({ limit: 2, cursor: firstPage.nextCursor! });
      assert.deepEqual(
        secondPage.checkIns.map((c) => c.summary),
        ["Check-in 0"],
      );
      assert.isNull(secondPage.nextCursor);

      yield* goals.reviewCheckIn({ id: all.checkIns[0]!.id, action: "approve" });
      assert.equal((yield* goals.listCheckIns({ status: "pending" })).checkIns.length, 2);
      assert.equal((yield* goals.listCheckIns({ agentId: "someone-else" })).checkIns.length, 0);
      assert.equal(
        (yield* Effect.flip(goals.listCheckIns({ cursor: "garbage" }))).reason,
        "invalid_cursor",
      );
    }),
  ),
);

const goalRun = (id: string, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(id),
    threadId: agentThread,
    userMessageId: `${id}-prompt`,
    status,
  }) as unknown as OrchestrationV2Run;

const addGoalTurn = (fakes: Fakes, runId: string, goalId: string | null, reply: string | null) =>
  Ref.update(fakes.messages, (all) => [
    ...all,
    {
      id: `${runId}-prompt`,
      runId,
      role: "user" as const,
      text: "prompt",
      streaming: false,
      ...(goalId === null ? {} : { scheduledTaskId: agentGoalTaskId(goalId) }),
    },
    ...(reply === null
      ? []
      : [
          {
            id: `${runId}-reply`,
            runId,
            role: "assistant" as const,
            text: reply,
            streaming: false,
          },
        ]),
  ]);

it.effect(
  "the fallback files exactly one check-in for a finished goal run, quoting its last reply",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const fallback = yield* AgentGoalFallback.AgentGoalFallback;
        const { goal } = yield* goals.upsertGoal(goalInput());
        yield* addGoalTurn(fakes, "run-a", goal.id, "Checked the inbox. Nothing new.");

        assert.isFalse(yield* fallback.handleRunUpdate(goalRun("run-a", "running")));
        assert.equal((yield* goals.listCheckIns({})).checkIns.length, 0);

        assert.isTrue(yield* fallback.handleRunUpdate(goalRun("run-a", "completed")));
        assert.isFalse(yield* fallback.handleRunUpdate(goalRun("run-a", "completed")));
        const { checkIns } = yield* goals.listCheckIns({});
        assert.equal(checkIns.length, 1);
        assert.equal(checkIns[0]?.source, "fallback");
        assert.equal(checkIns[0]?.summary, "Checked the inbox. Nothing new.");
        assert.equal(checkIns[0]?.runId, "run-a");
        assert.equal(checkIns[0]?.status, "pending");

        // Filing a check-in must never start another goal turn: nothing is sent, and the
        // goal's task has not fired.
        assert.equal((yield* Ref.get(fakes.sent)).length, 0);
        assert.equal((yield* taskFor(goal.id))?.runCount, 0);
      }),
    ),
);

it.effect(
  "the fallback files nothing when the agent already checked in, or when the run is not a goal turn",
  () =>
    withHarness((fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const fallback = yield* AgentGoalFallback.AgentGoalFallback;
        const { goal } = yield* goals.upsertGoal(goalInput());
        yield* addGoalTurn(fakes, "run-b", goal.id, "Done.");
        yield* goals.fileCheckIn({
          goalId: goal.id,
          threadId: agentThread,
          runId: RunId.make("run-b"),
          summary: "My own report",
        });
        assert.isFalse(yield* fallback.handleRunUpdate(goalRun("run-b", "completed")));

        yield* addGoalTurn(fakes, "run-c", null, "A normal chat reply");
        assert.isFalse(yield* fallback.handleRunUpdate(goalRun("run-c", "completed")));

        const { checkIns } = yield* goals.listCheckIns({});
        assert.deepEqual(
          checkIns.map((c) => [c.source, c.summary]),
          [["agent", "My own report"]],
        );
      }),
    ),
);

it.effect("the fallback names the terminal status when the turn left no reply", () =>
  withHarness((fakes) =>
    Effect.gen(function* () {
      yield* seedAgent;
      const goals = yield* AgentGoals.AgentGoals;
      const fallback = yield* AgentGoalFallback.AgentGoalFallback;
      const { goal } = yield* goals.upsertGoal(goalInput());
      yield* addGoalTurn(fakes, "run-d", goal.id, null);
      assert.isTrue(yield* fallback.handleRunUpdate(goalRun("run-d", "cancelled")));
      assert.include((yield* goals.listCheckIns({})).checkIns[0]?.summary ?? "", "cancelled");
    }),
  ),
);

it.effect("the started watcher turns a terminal run.updated event into a check-in", () => {
  const event = { type: "run.updated", payload: goalRun("run-e", "completed") };
  return withHarness(
    (fakes) =>
      Effect.gen(function* () {
        yield* seedAgent;
        const goals = yield* AgentGoals.AgentGoals;
        const fallback = yield* AgentGoalFallback.AgentGoalFallback;
        const { goal } = yield* goals.upsertGoal(goalInput());
        yield* addGoalTurn(fakes, "run-e", goal.id, "Reply from the watcher test.");
        // Subscribe first; the check-in change is the receipt that the watcher finished its work.
        const arrived = yield* goals.subscribeCheckIns({ agentId: "agent-1" }).pipe(
          Stream.filter((page) => page.checkIns.length > 0),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* fallback.start();
        const pages = yield* Fiber.join(arrived);
        assert.equal(pages[0]?.checkIns[0]?.summary, "Reply from the watcher test.");
      }),
    [event],
  );
});
