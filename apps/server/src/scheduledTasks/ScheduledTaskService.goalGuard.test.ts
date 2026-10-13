import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { agentGoalTaskId, type WorkbenchAgentGoal, type WorkspaceAgent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const now = "2026-09-09T12:00:00.000Z";

const goal = (id: string, status: WorkbenchAgentGoal["status"]): WorkbenchAgentGoal => ({
  id,
  title: `Goal ${id}`,
  outcome: "Keep it done.",
  schedule: { type: "interval", everyMs: 60_000 } as WorkbenchAgentGoal["schedule"],
  autonomy: "propose",
  status,
  scheduledTaskId: agentGoalTaskId(id),
  createdAt: now,
  updatedAt: now,
});

const agent = (
  id: string,
  goals: ReadonlyArray<WorkbenchAgentGoal>,
  archivedAt: string | null,
): WorkspaceAgent => ({
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
  primaryThreadId: null,
  goals,
  archivedAt,
  updatedAt: now,
});

const insertTask = (id: string, nextRunAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: id,
      title: "task",
      prompt: "Run task",
      enabled: 1,
      schedule_json: '{"type":"interval","everyMs":60000}',
      project_id: "project:test",
      thread_id: "thread:test",
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "server",
      created_at: now,
      updated_at: now,
      next_run_at: nextRunAt,
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
    })}`;
  });

it.effect("a due goal task only runs when a live, active goal stands behind it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspace = yield* AgentWorkspace.AgentWorkspace;
    yield* workspace.saveGoals({
      agent: agent("live-agent", [goal("live", "active")], null),
      expectedRevision: 0,
    });
    yield* workspace.saveGoals({
      agent: agent("archived-agent", [goal("archived", "active")], "2026-09-01T00:00:00.000Z"),
      expectedRevision: 0,
    });
    yield* workspace.saveGoals({
      agent: agent("paused-agent", [goal("paused", "paused")], null),
      expectedRevision: 0,
    });
    // Due in this order: the poll runs tasks one at a time, so the plain task's dispatch is
    // the receipt that every goal task before it was already decided.
    yield* insertTask("agent-goal:orphan", "2026-09-09T11:00:00.000Z");
    yield* insertTask("agent-goal:archived", "2026-09-09T11:01:00.000Z");
    yield* insertTask("agent-goal:paused", "2026-09-09T11:02:00.000Z");
    yield* insertTask("agent-goal:live", "2026-09-09T11:03:00.000Z");
    yield* insertTask("plain-task", "2026-09-09T11:04:00.000Z");

    const sent = yield* Ref.make<
      ReadonlyArray<{ readonly taskId: string | undefined; readonly mode: string }>
    >([]);
    const plainSent = yield* Deferred.make<void>();
    yield* TestClock.setTime(Date.parse(now) + 1_000);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          Layer.provideMerge(
            ScheduledTaskService.layer,
            Layer.mergeAll(
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                sendToThread: (input) =>
                  Ref.update(sent, (all) => [
                    ...all,
                    { taskId: input.scheduledTaskId, mode: input.mode ?? "" },
                  ]).pipe(
                    Effect.andThen(
                      input.scheduledTaskId === "plain-task"
                        ? Deferred.succeed(plainSent, undefined)
                        : Effect.void,
                    ),
                    Effect.as({} as never),
                  ),
              }),
              Layer.succeed(AgentWorkspace.AgentWorkspace, workspace),
              NodeCrypto.layer,
              Scheduler.layer,
            ),
          ),
        );
        // The poll loop delays before its first pass, so the frozen clock advances once.
        yield* TestClock.adjust("6 seconds");
        yield* Deferred.await(plainSent);
      }),
    );

    // Only the live goal (queued) and the ordinary task (steered as before) were sent.
    assert.deepEqual(yield* Ref.get(sent), [
      { taskId: "agent-goal:live", mode: "queue" },
      { taskId: "plain-task", mode: "auto" },
    ]);
    const rows = yield* sql<{
      task_id: string;
      enabled: number;
      next_run_at: string | null;
      run_count: number;
      last_run_status: string;
    }>`SELECT task_id, enabled, next_run_at, run_count, last_run_status FROM scheduled_tasks ORDER BY task_id`;
    const byId = new Map(rows.map((row) => [row.task_id, row]));
    for (const id of ["agent-goal:orphan", "agent-goal:archived", "agent-goal:paused"]) {
      const row = byId.get(id);
      assert.equal(row?.enabled, 0, id);
      assert.isNull(row?.next_run_at, id);
      assert.equal(row?.run_count, 0, id);
      assert.equal(row?.last_run_status, "never", id);
    }
    assert.equal(byId.get("agent-goal:live")?.enabled, 1);
    assert.equal(byId.get("agent-goal:live")?.run_count, 1);
    assert.equal(byId.get("plain-task")?.enabled, 1);
  }).pipe(Effect.provide(AgentWorkspace.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);
