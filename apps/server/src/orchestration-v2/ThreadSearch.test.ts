import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const TestLayer = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(TestLayer)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source, match.snippet]),
        [
          [both, "user", "newer needle question"],
          [assistantOnly, "assistant", "needle in an answer"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      // LIKE wildcards in the query match literally.
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.search({ query: "0260927" }));
      assert.equal(error.operation, "decode");
    }),
  );
  it.effect("returns a bounded original request instead of a later continuation", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:purpose");
      const id = ThreadId.make("thread:purpose");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(id, project),
          message(id, "purpose-system", "system", "System instructions", { minute: 0 }),
          message(id, "purpose-command", "user", "\n /help", { minute: 1 }),
          message(id, "purpose-blank", "user", "\t \n", { minute: 2 }),
          message(id, "purpose-stream", "user", "Unfinished", { minute: 3, streaming: true }),
          message(
            id,
            "purpose-original",
            "user",
            "<workbench-agent>Private agent instructions</workbench-agent>Build a session summary. " +
              "Keep original context. ".repeat(50),
            { minute: 4 },
          ),
          message(id, "purpose-recent", "user", "Now change the colors", { minute: 55 }),
        ],
        projections.apply,
        { discard: true },
      );
      const result = yield* search.originalRequest(id);
      assert.isTrue(result.text?.startsWith("Build a session summary.") ?? false);
      assert.isFalse(result.text?.includes("Private agent instructions") ?? true);
      assert.isTrue((result.text?.length ?? 999) <= 420);
      assert.isTrue(result.text?.endsWith("…") ?? false);
    }),
  );

  it.effect("reads a pending legacy import without hydrating or replacing its original goal", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:purpose-legacy");
      const id = ThreadId.make("thread:purpose-legacy");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(id, project),
          message(id, "legacy-latest", "user", "Recent continuation", { minute: 55 }),
        ],
        projections.apply,
        { discard: true },
      );
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
        VALUES (${id}, '2026-09-27T00:00:00Z', '2026-09-27T00:00:00Z', NULL)`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('legacy-original', ${id}, 'user', 'Build my original dashboard.', 0,
        '2026-09-27T00:01:00Z', '2026-09-27T00:01:00Z')`;
      assert.deepEqual(yield* search.originalRequest(id), { text: "Build my original dashboard." });
      const rows =
        yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${id}`;
      assert.isNull(rows[0]?.transcript_imported_at);
      // After hydration, V2 is authoritative. Do not resurrect legacy messages
      // that may have been intentionally removed from the current transcript.
      yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = '2026-09-27T01:00:00Z' WHERE thread_id = ${id}`;
      assert.deepEqual(yield* search.originalRequest(id), { text: "Recent continuation" });
    }),
  );

  it.effect("does not invent goals or expose deleted sessions and projects", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:purpose-deleted");
      const id = ThreadId.make("thread:purpose-deleted");
      const empty = ThreadId.make("thread:purpose-empty");
      const archived = ThreadId.make("thread:purpose-archived");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(id, project, { deletedAt: at(4) }),
          message(id, "deleted-purpose", "user", "Deleted content"),
          thread(empty, project),
          message(empty, "assistant-purpose", "assistant", "An assistant answer is not a goal"),
          thread(archived, project, { archivedAt: at(4) }),
          message(archived, "archived-purpose", "user", "Archived original request"),
        ],
        projections.apply,
        { discard: true },
      );
      assert.deepEqual(yield* search.originalRequest(id), { text: null });
      assert.deepEqual(yield* search.originalRequest(empty), { text: null });
      assert.deepEqual(yield* search.originalRequest(ThreadId.make("thread:purpose-missing")), {
        text: null,
      });
      assert.deepEqual(yield* search.originalRequest(archived), {
        text: "Archived original request",
      });
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-09-27T01:00:00Z' WHERE project_id = ${project}`;
      assert.deepEqual(yield* search.originalRequest(archived), { text: null });
    }),
  );
});
