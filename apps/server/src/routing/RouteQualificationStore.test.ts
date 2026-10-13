import * as DateTime from "effect/DateTime";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as Store from "./RouteQualificationStore.ts";
import type { QualificationEvidence } from "./qualificationPolicy.ts";
const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("a"),
  model: "m",
  options: [{ id: "effort", value: "medium" }],
};
const now = Date.parse("2026-10-03T10:00:00Z");
const evidence: QualificationEvidence = {
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  catalogReceipt: "catalog",
  toolReceipt: "tool",
  capabilityReceipt: "eval",
  contextTokens: 32000,
  billing: "free",
  billingReceipt: "cost-zero",
  inputMicroUsdPerMillion: 0,
  outputMicroUsdPerMillion: 0,
  requestMicroUsd: 0,
  spendingGuardReceipt: "free-only",
};
const layer = Store.layer.pipe(Layer.provide(Sqlite.SqlitePersistenceMemory));
it.effect("retains newer evidence, separates selections and supports revocation", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const store = yield* Store.RouteQualificationStore;
    const record = { binding: "a".repeat(64), evidence };
    yield* store.record(selection, record);
    yield* store.record(selection, {
      ...record,
      evidence: {
        ...evidence,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 1000)),
        toolReceipt: null,
      },
    });
    expect((yield* store.read(selection))?.evidence.toolReceipt).toBe("tool");
    expect(
      yield* store.read({ ...selection, options: [{ id: "effort", value: "high" }] }),
    ).toBeNull();
    expect(
      yield* store.read({ ...selection, instanceId: ProviderInstanceId.make("b") }),
    ).toBeNull();
    yield* store.revoke(selection);
    expect(yield* store.read(selection)).toBeNull();
  }).pipe(Effect.provide(layer)),
);
it.effect("rejects invalid money, future evidence and ambiguous options", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const store = yield* Store.RouteQualificationStore;
    for (const input of [
      { ...evidence, inputMicroUsdPerMillion: -1 },
      { ...evidence, requestMicroUsd: Number.MAX_SAFE_INTEGER + 1 },
      { ...evidence, contextTokens: 0 },
      { ...evidence, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) },
    ])
      expect(
        (yield* Effect.flip(store.record(selection, { binding: "a".repeat(64), evidence: input })))
          .reason,
      ).toBe("invalid_evidence");
    expect(
      (yield* Effect.flip(
        store.record(
          {
            ...selection,
            options: [
              { id: "effort", value: "low" },
              { id: "effort", value: "high" },
            ],
          },
          { binding: "a".repeat(64), evidence },
        ),
      )).reason,
    ).toBe("invalid_evidence");
  }).pipe(Effect.provide(layer)),
);
it.effect("recovers evidence after reopening a real SQLite database", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-qualification-" });
    const persistence = Sqlite.makeSqlitePersistenceLive(`${directory}/state.sqlite`);
    const persisted = Store.layer.pipe(Layer.provide(persistence));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* Store.RouteQualificationStore).record(selection, {
          binding: "a".repeat(64),
          evidence,
        });
      }).pipe(Effect.provide(persisted)),
    );
    const restored = yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* (yield* Store.RouteQualificationStore).read(selection);
      }).pipe(Effect.provide(persisted)),
    );
    expect(restored?.evidence).toEqual(evidence);
  }).pipe(Effect.provide(NodeServices.layer)),
);
