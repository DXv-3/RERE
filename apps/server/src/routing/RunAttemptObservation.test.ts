import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunAttemptId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Settings from "../serverSettings.ts";
import * as Providers from "../provider/Services/ProviderRegistry.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as Observation from "./RunAttemptObservation.ts";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const now = Date.parse("2026-10-03T11:20:00Z");
const id = ProviderInstanceId.make("account-a");
const provider: ServerProvider = {
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  version: "1",
  auth: { status: "authenticated", profileId: "private-account", email: "private@example.test" },
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  models: [{ slug: "m", name: "Model", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
};
const input = {
  attemptId: RunAttemptId.make("attempt-a"),
  runId: RunId.make("run-a"),
  threadId: ThreadId.make("thread-a"),
  selection: { instanceId: id, model: "m" },
};
const settings = Settings.layerTest();
const makeLayer = (snapshots: Effect.Effect<readonly ServerProvider[]>, settingsLayer = settings) =>
  Observation.observerLive.pipe(
    Layer.provide(Layer.mock(Providers.ProviderRegistry)({ getProviders: snapshots })),
    Layer.provide(settingsLayer),
  );
const rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    binding: string | null;
    state: string;
    conflicted: number;
    observed_at: number;
    selection_json: string;
  }>`SELECT * FROM workbench_run_observations ORDER BY attempt_id`;
});
it.effect("records private attempt provenance without promoting a qualification", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const observer = yield* Observation.RunAttemptObserver;
    yield* observer.capture(input);
    const [row] = yield* rows;
    expect(row?.state).toBe("snapshot_only");
    expect(row?.binding).toMatch(/^[a-f0-9]{64}$/);
    expect(yield* encodeJson(row)).not.toContain("private-account");
    expect(yield* encodeJson(row)).not.toContain("private@example.test");
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT * FROM workbench_route_qualifications`).toHaveLength(0);
  }).pipe(
    Effect.provide(
      makeLayer(Effect.succeed([provider])).pipe(
        Layer.provideMerge(Sqlite.SqlitePersistenceMemory),
      ),
    ),
  ),
);
it.effect("preserves first binding, detects replay under another account and stays poisoned", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const snapshot = yield* Ref.make<readonly ServerProvider[]>([provider]);
    yield* Effect.gen(function* () {
      const observer = yield* Observation.RunAttemptObserver;
      yield* observer.capture(input);
      const initial = (yield* rows)[0]!;
      yield* observer.capture(input);
      expect((yield* rows)[0]?.conflicted).toBe(0);
      yield* Ref.set(snapshot, [
        { ...provider, auth: { status: "authenticated", profileId: "different-account" } },
      ]);
      yield* observer.capture(input);
      const changed = (yield* rows)[0]!;
      expect(changed.conflicted).toBe(1);
      expect(changed.binding).toBe(initial.binding);
      expect(changed.observed_at).toBe(initial.observed_at);
      yield* Ref.set(snapshot, [provider]);
      yield* observer.capture(input);
      expect((yield* rows)[0]?.conflicted).toBe(1);
      yield* observer.capture({ ...input, attemptId: RunAttemptId.make("attempt-b") });
      expect(yield* rows).toHaveLength(2);
    }).pipe(Effect.provide(makeLayer(Ref.get(snapshot))));
  }).pipe(Effect.provide(Sqlite.SqlitePersistenceMemory)),
);
it.effect("keeps stale, future and missing account observations unverified", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const snapshots = [
      { ...provider, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 300001)) },
      { ...provider, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) },
      { ...provider, auth: { status: "unknown" as const } },
    ];
    for (const [index, snapshot] of snapshots.entries()) {
      yield* Effect.gen(function* () {
        yield* (yield* Observation.RunAttemptObserver).capture({
          ...input,
          attemptId: RunAttemptId.make(`attempt-${index}`),
        });
      }).pipe(Effect.provide(makeLayer(Effect.succeed([snapshot]))));
    }
    expect((yield* rows).map((row) => [row.binding, row.state])).toEqual([
      [null, "snapshot_stale"],
      [null, "snapshot_stale"],
      [null, "identity_unverified"],
    ]);
  }).pipe(Effect.provide(Sqlite.SqlitePersistenceMemory)),
);
it.effect("does not silently rewrite model options on the same attempt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const observer = yield* Observation.RunAttemptObserver;
    yield* observer.capture(input);
    yield* observer.capture({
      ...input,
      selection: { ...input.selection, options: [{ id: "effort", value: "high" }] },
    });
    const [row] = yield* rows;
    expect(row?.conflicted).toBe(1);
    expect(row?.selection_json).not.toContain("high");
  }).pipe(
    Effect.provide(
      makeLayer(Effect.succeed([provider])).pipe(
        Layer.provideMerge(Sqlite.SqlitePersistenceMemory),
      ),
    ),
  ),
);
it.effect("observation failures do not fail manual execution or create evidence", () =>
  Effect.gen(function* () {
    yield* (yield* Observation.RunAttemptObserver).capture(input);
    expect(yield* rows).toHaveLength(0);
  }).pipe(
    Effect.provide(
      makeLayer(Effect.die("private-credential-must-not-be-logged")).pipe(
        Layer.provideMerge(Sqlite.SqlitePersistenceMemory),
      ),
    ),
  ),
);
it.effect("recovers the original attempt binding after a database reopen", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-run-observation-" });
    const db = Sqlite.makeSqlitePersistenceLive(`${dir}/state.sqlite`);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* Observation.RunAttemptObserver).capture(input);
      }).pipe(Effect.provide(makeLayer(Effect.succeed([provider])).pipe(Layer.provideMerge(db)))),
    );
    const restored = yield* Effect.scoped(rows.pipe(Effect.provide(db)));
    expect(restored[0]?.state).toBe("snapshot_only");
    expect(restored[0]?.binding).toMatch(/^[a-f0-9]{64}$/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a configuration changing across the snapshot read", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const base = yield* Effect.gen(function* () {
      return yield* (yield* Settings.ServerSettingsService).getSettings;
    }).pipe(Effect.provide(settings));
    const count = yield* Ref.make(0);
    const changing = Layer.mock(Settings.ServerSettingsService)({
      getSettings: Ref.modify(
        count,
        (n) =>
          [
            n === 0
              ? base
              : {
                  ...base,
                  providerInstances: {
                    [id]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
                  },
                },
            n + 1,
          ] as const,
      ),
    });
    yield* Effect.gen(function* () {
      yield* (yield* Observation.RunAttemptObserver).capture(input);
    }).pipe(Effect.provide(makeLayer(Effect.succeed([provider]), changing)));
    const [row] = yield* rows;
    expect(row?.state).toBe("configuration_changed");
    expect(row?.binding).toBeNull();
  }).pipe(Effect.provide(Sqlite.SqlitePersistenceMemory)),
);
it.effect("bounds a stuck observation without delaying manual dispatch indefinitely", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const snapshots = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    const fiber = yield* Effect.gen(function* () {
      yield* (yield* Observation.RunAttemptObserver).capture(input);
    }).pipe(Effect.provide(makeLayer(snapshots)), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(yield* rows).toHaveLength(0);
  }).pipe(Effect.provide(Sqlite.SqlitePersistenceMemory)),
);
