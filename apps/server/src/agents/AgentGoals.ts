import {
  AGENT_CHECKIN_NOTE_MAX,
  AGENT_CHECKIN_SUMMARY_MAX,
  AGENT_GOAL_MAX_COUNT,
  AgentCheckIn,
  AgentGoalError,
  CommandId,
  MessageId,
  ThreadId,
  agentGoalTaskId,
  type AgentCheckInFilter,
  type AgentCheckInListInput,
  type AgentCheckInPage,
  type AgentCheckInReviewInput,
  type AgentGoalDeleteInput,
  type AgentGoalDeleteResult,
  type AgentGoalResult,
  type AgentGoalSetStatusInput,
  type AgentGoalUpsertInput,
  type RunId,
  type WorkbenchAgentGoal,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as AgentWorkspace from "./AgentWorkspace.ts";
import { buildGoalTurnPrompt } from "./goalPrompt.ts";

/** A goal with this many unreviewed check-ins stops running until the owner resumes it. */
export const UNREVIEWED_CHECKIN_LIMIT = 5;
const DEFAULT_PAGE_SIZE = 50;
/** `saveGoals` is optimistic; a concurrent goal edit gets this many fresh reads before it gives up. */
const SAVE_CONFLICT_RETRIES = 2;

export interface FileCheckInInput {
  readonly goalId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly summary: string;
  readonly needsFromOwner?: string | null;
  /** The agent says the goal's outcome is achieved. */
  readonly done?: boolean;
}

export class AgentGoals extends Context.Service<
  AgentGoals,
  {
    readonly upsertGoal: (
      input: AgentGoalUpsertInput,
    ) => Effect.Effect<AgentGoalResult, AgentGoalError>;
    /**
     * With `byAgent` the caller is the agent itself: it may pause or finish a goal but not resume one
     * (`owner_only_resume`), since a pause can be the owner's or the unreviewed check-in cap.
     */
    readonly setStatus: (
      input: AgentGoalSetStatusInput,
      options?: { readonly byAgent?: boolean },
    ) => Effect.Effect<AgentGoalResult, AgentGoalError>;
    readonly deleteGoal: (
      input: AgentGoalDeleteInput,
    ) => Effect.Effect<AgentGoalDeleteResult, AgentGoalError>;
    /** Finds a goal, and the agent that holds it, by goal id. */
    readonly findGoal: (
      goalId: string,
    ) => Effect.Effect<
      { readonly agent: WorkspaceAgent; readonly goal: WorkbenchAgentGoal },
      AgentGoalError
    >;
    /**
     * The agent's own check-in. A second one for the same goal and run replaces the first
     * while it is still pending, so an agent can correct itself.
     */
    readonly fileCheckIn: (
      input: FileCheckInInput,
    ) => Effect.Effect<
      { readonly checkIn: AgentCheckIn; readonly goal: WorkbenchAgentGoal },
      AgentGoalError
    >;
    /** The server's stand-in for a turn that ended without a check-in. Null when the run already has one. */
    readonly fileFallbackCheckIn: (
      input: Omit<FileCheckInInput, "needsFromOwner" | "done"> & { readonly runId: RunId },
    ) => Effect.Effect<AgentCheckIn | null, AgentGoalError>;
    readonly reviewCheckIn: (
      input: AgentCheckInReviewInput,
    ) => Effect.Effect<AgentCheckIn, AgentGoalError>;
    readonly listCheckIns: (
      input: AgentCheckInListInput,
    ) => Effect.Effect<AgentCheckInPage, AgentGoalError>;
    /** Emits the first page on subscribe and again after every check-in change. */
    readonly subscribeCheckIns: (
      filter: AgentCheckInFilter,
    ) => Stream.Stream<AgentCheckInPage, AgentGoalError>;
  }
>()("t3/agents/AgentGoals") {}

const failure = (reason: AgentGoalError["reason"]) => new AgentGoalError({ reason });
const storage = () => failure("storage");
const decodeCheckIn = Schema.decodeUnknownEffect(AgentCheckIn);
const clip = (value: string, max: number) => (value.length <= max ? value : value.slice(0, max));

interface CheckInRow {
  readonly id: string;
  readonly agent_id: string;
  readonly goal_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly created_at: string;
  readonly summary: string;
  readonly needs_from_owner: string | null;
  readonly source: string;
  readonly status: string;
  readonly owner_note: string | null;
  readonly reviewed_at: string | null;
}

const toCheckIn = (row: CheckInRow) =>
  decodeCheckIn({
    id: row.id,
    agentId: row.agent_id,
    goalId: row.goal_id,
    threadId: row.thread_id,
    runId: row.run_id,
    createdAt: row.created_at,
    summary: row.summary,
    needsFromOwner: row.needs_from_owner,
    source: row.source,
    status: row.status,
    ownerNote: row.owner_note,
    reviewedAt: row.reviewed_at,
  }).pipe(Effect.mapError(storage));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // Sliding(1) coalesces the dirty signal: every notification re-lists anyway.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const randomId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}:${uuid}`),
      Effect.mapError(storage),
    );

  const readAgent = (agentId: string) =>
    agents
      .read(agentId)
      .pipe(
        Effect.mapError((error) =>
          error.reason === "not_found" ? failure("agent_not_found") : storage(),
        ),
      );

  /**
   * Reads the agent, lets `change` produce its next goals, and saves them. A save that
   * loses to a concurrent edit starts over from a fresh read, so `change` must be pure.
   */
  const updateGoals = <A>(
    agentId: string,
    change: (
      agent: WorkspaceAgent,
    ) => Effect.Effect<
      { readonly goals: ReadonlyArray<WorkbenchAgentGoal>; readonly value: A },
      AgentGoalError
    >,
  ) =>
    Effect.gen(function* () {
      const agent = yield* readAgent(agentId);
      const next = yield* change(agent);
      const saved = yield* agents
        .saveGoals({ agent: { ...agent, goals: next.goals }, expectedRevision: agent.revision })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "conflict"
              ? failure("conflict")
              : error.reason === "not_found"
                ? failure("agent_not_found")
                : storage(),
          ),
        );
      return { agent: saved, value: next.value };
    }).pipe(
      Effect.retry({
        times: SAVE_CONFLICT_RETRIES,
        while: (error) => error.reason === "conflict",
      }),
    );

  const findGoal: AgentGoals["Service"]["findGoal"] = Effect.fn("AgentGoals.findGoal")(
    function* (goalId) {
      const all = yield* agents.list.pipe(Effect.mapError(storage));
      for (const agent of all) {
        const goal = agent.goals?.find((candidate) => candidate.id === goalId);
        if (goal !== undefined) return { agent, goal };
      }
      return yield* failure("goal_not_found");
    },
  );

  const latestCheckIn = (goalId: string) =>
    sql<CheckInRow>`
      SELECT * FROM workbench_agent_checkins WHERE goal_id = ${goalId}
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `.pipe(Effect.mapError(storage));

  const latestOwnerNote = (goalId: string) =>
    sql<{ readonly owner_note: string }>`
      SELECT owner_note FROM workbench_agent_checkins
      WHERE goal_id = ${goalId} AND owner_note IS NOT NULL
      ORDER BY reviewed_at DESC, rowid DESC LIMIT 1
    `.pipe(Effect.mapError(storage));

  const pendingCount = (goalId: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM workbench_agent_checkins
      WHERE goal_id = ${goalId} AND status = 'pending'
    `.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.mapError(storage),
    );

  /**
   * Makes the goal's scheduled task match the goal: schedule, enabled flag, and a prompt
   * rebuilt from the latest check-in and owner note. Idempotent, so every goal or
   * check-in change calls it. The task follows the agent's thread settings each time.
   */
  const syncTask = Effect.fn("AgentGoals.syncTask")(function* (
    agent: WorkspaceAgent,
    goal: WorkbenchAgentGoal,
  ) {
    const taskId = agentGoalTaskId(goal.id);
    const [previousRows, noteRows] = yield* Effect.all([
      latestCheckIn(goal.id),
      latestOwnerNote(goal.id),
    ]);
    const previous = previousRows[0] === undefined ? null : yield* toCheckIn(previousRows[0]);
    const prompt = buildGoalTurnPrompt({
      goal,
      previous,
      ownerNote: noteRows[0]?.owner_note ?? null,
    });
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(Effect.mapError(() => failure("task_failed")));
    const existing = tasks.find((task) => task.id === taskId);
    const shell =
      agent.primaryThreadId === null
        ? null
        : yield* threads
            .getThreadShell(ThreadId.make(agent.primaryThreadId))
            .pipe(Effect.orElseSucceed(() => null));
    const live = shell !== null && shell.archivedAt === null ? shell : null;
    const base = live ?? existing;
    const threadId = agent.primaryThreadId ?? existing?.threadId ?? null;
    if (threadId === null) return yield* failure("no_primary_thread");
    if (base === undefined || base === null) return yield* failure("thread_unavailable");
    yield* scheduledTasks
      .upsert({
        id: taskId,
        title: goal.title,
        prompt,
        enabled: goal.status === "active",
        schedule: goal.schedule,
        projectId: base.projectId,
        threadId: ThreadId.make(threadId),
        workspaceStrategy: { type: "root" },
        modelSelection: base.modelSelection,
        runtimeMode: base.runtimeMode,
        interactionMode: base.interactionMode,
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(() => failure("task_failed")));
  });

  const assertCanRun = (agent: WorkspaceAgent) =>
    agent.archivedAt
      ? failure("agent_archived")
      : agent.primaryThreadId === null
        ? failure("no_primary_thread")
        : null;

  const upsertGoal: AgentGoals["Service"]["upsertGoal"] = Effect.fn("AgentGoals.upsertGoal")(
    function* (input) {
      const timestamp = yield* nowIso;
      const generatedId = input.goalId === undefined ? yield* randomId("goal") : null;
      const { agent, value } = yield* updateGoals(input.agentId, (current) =>
        Effect.gen(function* () {
          const blocked = assertCanRun(current);
          if (blocked !== null) return yield* blocked;
          const goals = current.goals ?? [];
          const existing = goals.find((goal) => goal.id === input.goalId);
          if (input.goalId !== undefined && existing === undefined) {
            return yield* failure("goal_not_found");
          }
          if (existing === undefined && goals.length >= AGENT_GOAL_MAX_COUNT) {
            return yield* failure("goal_limit");
          }
          const id = existing?.id ?? generatedId ?? input.goalId ?? "";
          const goal: WorkbenchAgentGoal = {
            ...existing,
            id,
            title: input.title,
            outcome: input.outcome,
            schedule: input.schedule,
            autonomy: input.autonomy,
            status: existing?.status ?? "active",
            scheduledTaskId: agentGoalTaskId(id),
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
          return {
            goals: existing
              ? goals.map((candidate) => (candidate.id === id ? goal : candidate))
              : [...goals, goal],
            value: { goal, created: existing === undefined },
          };
        }),
      );
      yield* syncTask(agent, value.goal).pipe(
        // A goal whose task never existed would look active and never run, so a failed
        // create is undone rather than left half-made. An edit keeps its old task.
        Effect.tapError(() =>
          value.created
            ? updateGoals(input.agentId, (current) =>
                Effect.succeed({
                  goals: (current.goals ?? []).filter((goal) => goal.id !== value.goal.id),
                  value: null,
                }),
              ).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      return { agent, goal: value.goal };
    },
  );

  const setStatus: AgentGoals["Service"]["setStatus"] = Effect.fn("AgentGoals.setStatus")(
    function* (input, options) {
      const timestamp = yield* nowIso;
      const { agent, value: goal } = yield* updateGoals(input.agentId, (current) =>
        Effect.gen(function* () {
          const goals = current.goals ?? [];
          const existing = goals.find((candidate) => candidate.id === input.goalId);
          if (existing === undefined) return yield* failure("goal_not_found");
          if (
            options?.byAgent === true &&
            input.status === "active" &&
            existing.status !== "active"
          ) {
            return yield* failure("owner_only_resume");
          }
          if (input.status === "active") {
            const blocked = assertCanRun(current);
            if (blocked !== null) return yield* blocked;
          }
          const { pausedReason: _previousReason, ...rest } = existing;
          const goal: WorkbenchAgentGoal = {
            ...rest,
            status: input.status,
            ...(input.status === "paused" ? { pausedReason: "owner" as const } : {}),
            updatedAt: timestamp,
          };
          return {
            goals: goals.map((candidate) => (candidate.id === goal.id ? goal : candidate)),
            value: goal,
          };
        }),
      );
      yield* syncTask(agent, goal);
      return { agent, goal };
    },
  );

  const deleteGoal: AgentGoals["Service"]["deleteGoal"] = Effect.fn("AgentGoals.deleteGoal")(
    function* (input) {
      const { agent } = yield* updateGoals(input.agentId, (current) =>
        Effect.gen(function* () {
          const goals = current.goals ?? [];
          if (!goals.some((goal) => goal.id === input.goalId)) {
            return yield* failure("goal_not_found");
          }
          return {
            goals: goals.filter((goal) => goal.id !== input.goalId),
            value: null,
          };
        }),
      );
      yield* scheduledTasks
        .delete({ id: agentGoalTaskId(input.goalId) })
        .pipe(Effect.mapError(() => failure("task_failed")));
      return { agent };
    },
  );

  const selectCheckIn = (id: string) =>
    sql<CheckInRow>`SELECT * FROM workbench_agent_checkins WHERE id = ${id}`.pipe(
      Effect.mapError(storage),
    );

  /**
   * Inserts the check-in. A goal has at most one per run: the agent's own report may replace
   * a pending one, the fallback never does. Returns null when the fallback finds one in place.
   */
  const insertCheckIn = Effect.fn("AgentGoals.insertCheckIn")(function* (
    agent: WorkspaceAgent,
    input: FileCheckInInput,
    source: "agent" | "fallback",
  ) {
    const id = yield* randomId("checkin");
    const createdAt = yield* nowIso;
    const summary = clip(input.summary.trim(), AGENT_CHECKIN_SUMMARY_MAX);
    const needs = input.needsFromOwner?.trim();
    const needsFromOwner =
      needs === undefined || needs === "" ? null : clip(needs, AGENT_CHECKIN_NOTE_MAX);
    const inserted =
      source === "agent"
        ? yield* sql<{ readonly id: string }>`
            INSERT INTO workbench_agent_checkins
              (id, agent_id, goal_id, thread_id, run_id, created_at, summary, needs_from_owner, source, status)
            VALUES (${id}, ${agent.profile.id}, ${input.goalId}, ${input.threadId}, ${input.runId},
              ${createdAt}, ${summary}, ${needsFromOwner}, 'agent', 'pending')
            ON CONFLICT (goal_id, run_id) DO UPDATE SET
              summary = excluded.summary,
              needs_from_owner = excluded.needs_from_owner,
              source = excluded.source
            WHERE workbench_agent_checkins.status = 'pending'
            RETURNING id
          `.pipe(Effect.mapError(storage))
        : yield* sql<{ readonly id: string }>`
            INSERT INTO workbench_agent_checkins
              (id, agent_id, goal_id, thread_id, run_id, created_at, summary, needs_from_owner, source, status)
            VALUES (${id}, ${agent.profile.id}, ${input.goalId}, ${input.threadId}, ${input.runId},
              ${createdAt}, ${summary}, ${needsFromOwner}, 'fallback', 'pending')
            ON CONFLICT (goal_id, run_id) DO NOTHING
            RETURNING id
          `.pipe(Effect.mapError(storage));
    if (inserted[0] !== undefined) {
      const rows = yield* selectCheckIn(inserted[0].id);
      return rows[0] === undefined ? yield* storage() : yield* toCheckIn(rows[0]);
    }
    if (source === "fallback") return null;
    // The agent's earlier check-in for this run was already reviewed; keep it as is.
    const existing = yield* sql<CheckInRow>`
      SELECT * FROM workbench_agent_checkins WHERE goal_id = ${input.goalId} AND run_id = ${input.runId}
    `.pipe(Effect.mapError(storage));
    return existing[0] === undefined ? yield* storage() : yield* toCheckIn(existing[0]);
  });

  /** Brings the goal in line with its check-ins: done, or paused for unreviewed ones. */
  const settleGoal = Effect.fn("AgentGoals.settleGoal")(function* (
    agentId: string,
    goalId: string,
    done: boolean,
  ) {
    const pending = yield* pendingCount(goalId);
    const timestamp = yield* nowIso;
    return yield* updateGoals(agentId, (current) =>
      Effect.gen(function* () {
        const goals = current.goals ?? [];
        const existing = goals.find((goal) => goal.id === goalId);
        if (existing === undefined) return yield* failure("goal_not_found");
        const { pausedReason: _reason, ...rest } = existing;
        const next: WorkbenchAgentGoal =
          done && existing.status !== "done"
            ? { ...rest, status: "done", updatedAt: timestamp }
            : existing.status === "active" && pending >= UNREVIEWED_CHECKIN_LIMIT
              ? {
                  ...rest,
                  status: "paused",
                  pausedReason: "unreviewed_limit",
                  updatedAt: timestamp,
                }
              : existing;
        return {
          goals:
            next === existing ? goals : goals.map((goal) => (goal.id === goalId ? next : goal)),
          value: next,
        };
      }),
    );
  });

  const fileCheckIn: AgentGoals["Service"]["fileCheckIn"] = Effect.fn("AgentGoals.fileCheckIn")(
    function* (input) {
      const { agent } = yield* findGoal(input.goalId);
      const checkIn = yield* insertCheckIn(agent, input, "agent");
      if (checkIn === null) return yield* storage();
      const settled = yield* settleGoal(agent.profile.id, input.goalId, input.done === true);
      yield* syncTask(settled.agent, settled.value);
      yield* notifyChanged;
      return { checkIn, goal: settled.value };
    },
  );

  const fileFallbackCheckIn: AgentGoals["Service"]["fileFallbackCheckIn"] = Effect.fn(
    "AgentGoals.fileFallbackCheckIn",
  )(function* (input) {
    const { agent } = yield* findGoal(input.goalId);
    const checkIn = yield* insertCheckIn(agent, input, "fallback");
    if (checkIn === null) return null;
    const settled = yield* settleGoal(agent.profile.id, input.goalId, false);
    yield* syncTask(settled.agent, settled.value);
    yield* notifyChanged;
    return checkIn;
  });

  const reviewCheckIn: AgentGoals["Service"]["reviewCheckIn"] = Effect.fn(
    "AgentGoals.reviewCheckIn",
  )(function* (input) {
    const rows = yield* selectCheckIn(input.id);
    if (rows[0] === undefined) return yield* failure("checkin_not_found");
    const current = yield* toCheckIn(rows[0]);
    if (current.status !== "pending") return yield* failure("already_reviewed");
    const note = input.note?.trim() ?? "";
    if (input.action === "redirect" && note === "") return yield* failure("note_required");

    const found = yield* Effect.result(findGoal(current.goalId));
    if (input.action === "redirect") {
      // Send first: a redirect that was recorded but never delivered would be silently lost,
      // while a delivered one that fails to record is replayed harmlessly by its command id.
      const shell = yield* threads
        .getThreadShell(current.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.archivedAt !== null) return yield* failure("thread_unavailable");
      const title = found._tag === "Success" ? found.success.goal.title : null;
      yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`agent-checkin-redirect:${current.id}`),
          threadId: current.threadId,
          messageId: MessageId.make(`agent-checkin-redirect-message:${current.id}`),
          text:
            title === null
              ? `The owner redirected you on your last check-in:\n\n${note}`
              : `The owner redirected you on your check-in for the goal "${title}":\n\n${note}`,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(() => failure("thread_unavailable")));
    }
    const status =
      input.action === "approve"
        ? "approved"
        : input.action === "redirect"
          ? "redirected"
          : "dismissed";
    const reviewedAt = yield* nowIso;
    const stored = note === "" ? null : clip(note, AGENT_CHECKIN_NOTE_MAX);
    const updated = yield* sql<CheckInRow>`
      UPDATE workbench_agent_checkins
      SET status = ${status}, owner_note = ${stored}, reviewed_at = ${reviewedAt}
      WHERE id = ${current.id} AND status = 'pending'
      RETURNING *
    `.pipe(Effect.mapError(storage));
    if (updated[0] === undefined) return yield* failure("already_reviewed");
    // The goal may be gone (check-ins are kept as history); then there is no prompt to refresh.
    if (found._tag === "Success") {
      yield* syncTask(found.success.agent, found.success.goal);
    }
    yield* notifyChanged;
    return yield* toCheckIn(updated[0]);
  });

  const listCheckIns: AgentGoals["Service"]["listCheckIns"] = Effect.fn("AgentGoals.listCheckIns")(
    function* (input) {
      const limit = input.limit ?? DEFAULT_PAGE_SIZE;
      let after = sql``;
      if (input.cursor !== undefined) {
        const separator = input.cursor.lastIndexOf("|");
        const rowId = Number(input.cursor.slice(separator + 1));
        if (separator < 1 || !Number.isInteger(rowId)) return yield* failure("invalid_cursor");
        const createdAt = input.cursor.slice(0, separator);
        after = sql`AND (created_at < ${createdAt} OR (created_at = ${createdAt} AND rowid < ${rowId}))`;
      }
      const rows = yield* sql<CheckInRow & { readonly row_id: number }>`
      SELECT rowid AS row_id, * FROM workbench_agent_checkins
      WHERE 1 = 1
        ${input.agentId === undefined ? sql`` : sql`AND agent_id = ${input.agentId}`}
        ${input.goalId === undefined ? sql`` : sql`AND goal_id = ${input.goalId}`}
        ${input.status === undefined ? sql`` : sql`AND status = ${input.status}`}
        ${after}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(storage));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        checkIns: yield* Effect.forEach(page, toCheckIn),
        nextCursor:
          rows.length > limit && last !== undefined ? `${last.created_at}|${last.row_id}` : null,
      };
    },
  );

  const subscribeCheckIns: AgentGoals["Service"]["subscribeCheckIns"] = (filter) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the snapshot so a change landing between the two is buffered.
        const subscription = yield* PubSub.subscribe(changes);
        const page = listCheckIns(filter);
        return Stream.concat(
          Stream.fromEffect(page),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => page)),
        );
      }),
    );

  return AgentGoals.of({
    upsertGoal,
    setStatus,
    deleteGoal,
    findGoal,
    fileCheckIn,
    fileFallbackCheckIn,
    reviewCheckIn,
    listCheckIns,
    subscribeCheckIns,
  });
});

export const layer = Layer.effect(AgentGoals, make);
