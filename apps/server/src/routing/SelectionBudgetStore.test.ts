import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as SelectionBudgetStore from "./SelectionBudgetStore.ts";

const memory = SelectionBudgetStore.layer.pipe(
  Layer.provide(SqlitePersistence.SqlitePersistenceMemory),
);
const request = (requestId: string, maxCostMicroUsd = 10_000) => ({
  requestId,
  maxCostMicroUsd,
  fingerprint: "a".repeat(64),
});

// One reservation is capped at $0.10 by the table; fill the day with several of them.
const fill = (count: number) =>
  Effect.gen(function* () {
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    for (let index = 0; index < count; index++) {
      yield* budget.reserve(request(`fill-${index}`, 100_000));
    }
  });

it.effect("atomically admits concurrent requests only up to the selection cap", () =>
  Effect.gen(function* () {
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    const results = yield* Effect.all(
      Array.from({ length: 200 }, (_, index) =>
        Effect.result(budget.reserve(request(`task-${index}`))),
      ),
      { concurrency: "unbounded" },
    );
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(100);
    expect(
      results
        .filter((r) => r._tag === "Failure")
        .every((r) => r.failure.reason === "budget_exhausted"),
    ).toBe(true);
    expect(yield* budget.snapshot).toMatchObject({
      capMicroUsd: 1_000_000,
      heldMicroUsd: 1_000_000,
      availableMicroUsd: 0,
    });
  }).pipe(Effect.provide(memory)),
);

it.effect("deduplicates reservations and gives exactly one caller permission to send", () =>
  Effect.gen(function* () {
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    const reservations = yield* Effect.all(
      Array.from({ length: 8 }, () => budget.reserve(request("same"))),
      { concurrency: "unbounded" },
    );
    expect(reservations.filter((r) => r.created)).toHaveLength(1);
    const claims = yield* Effect.all(
      Array.from({ length: 8 }, () => budget.beginDispatch("same")),
      { concurrency: "unbounded" },
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(yield* budget.snapshot).toMatchObject({ heldMicroUsd: 10_000, unresolvedRequests: 1 });
    const changed = yield* Effect.flip(
      budget.reserve({ ...request("same"), fingerprint: "b".repeat(64) }),
    );
    expect(changed.reason).toBe("request_conflict");
  }).pipe(Effect.provide(memory)),
);

it.effect("keeps unknown charges held across midnight and refuses timeout refunds", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-03T03:59:00Z"));
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    yield* fill(9);
    yield* budget.reserve(request("uncertain", 80_000));
    expect(yield* budget.beginDispatch("uncertain")).toBe(true);
    yield* TestClock.setTime(Date.parse("2026-10-03T04:01:00Z"));
    expect(yield* budget.snapshot).toMatchObject({
      day: "2026-10-03",
      heldMicroUsd: 980_000,
      availableMicroUsd: 20_000,
    });
    expect((yield* Effect.flip(budget.releaseUnsent("uncertain"))).reason).toBe(
      "invalid_transition",
    );
    expect((yield* Effect.flip(budget.reserve(request("next", 30_000)))).reason).toBe(
      "budget_exhausted",
    );
    expect(yield* budget.beginDispatch("uncertain")).toBe(false);
    yield* budget.settle({
      requestId: "uncertain",
      receiptId: "receipt-1",
      actualMicroUsd: 70_000,
    });
    expect(yield* budget.snapshot).toMatchObject({
      spentMicroUsd: 70_000,
      heldMicroUsd: 900_000,
      availableMicroUsd: 30_000,
    });
  }).pipe(Effect.provide(memory)),
);

it.effect("releases only unsent work and never revives a cancelled request on replay", () =>
  Effect.gen(function* () {
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    yield* budget.reserve(request("cancelled", 100_000));
    yield* budget.releaseUnsent("cancelled");
    yield* budget.releaseUnsent("cancelled");
    expect(yield* budget.reserve(request("cancelled", 100_000))).toMatchObject({
      created: false,
      reservation: { state: "released" },
    });
    expect(yield* budget.beginDispatch("cancelled")).toBe(false);
    expect(yield* budget.snapshot).toMatchObject({ availableMicroUsd: 1_000_000 });
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "does not dispatch an old-day reservation, including at the daylight saving boundary",
  () =>
    Effect.gen(function* () {
      const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
      yield* TestClock.setTime(Date.parse("2026-11-01T03:59:00Z"));
      yield* budget.reserve(request("old"));
      expect(yield* budget.snapshot).toMatchObject({ day: "2026-10-31" });
      yield* TestClock.setTime(Date.parse("2026-11-01T04:01:00Z"));
      expect(yield* budget.snapshot).toMatchObject({ day: "2026-11-01", heldMicroUsd: 10_000 });
      expect(yield* budget.beginDispatch("old")).toBe(false);
      yield* budget.releaseUnsent("old");
      yield* budget.reserve(request("new"));
      expect(yield* budget.beginDispatch("new")).toBe(true);
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "reconciles once, frees unused reservation and rejects conflicting or reused receipts",
  () =>
    Effect.gen(function* () {
      const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
      yield* budget.reserve(request("one", 50_000));
      yield* budget.beginDispatch("one");
      const receipt = { requestId: "one", receiptId: "paid-1", actualMicroUsd: 20_000 };
      yield* budget.settle(receipt);
      yield* budget.settle(receipt);
      expect(yield* budget.snapshot).toMatchObject({
        spentMicroUsd: 20_000,
        heldMicroUsd: 0,
        availableMicroUsd: 980_000,
      });
      expect(
        (yield* Effect.flip(budget.settle({ ...receipt, actualMicroUsd: 10_000 }))).reason,
      ).toBe("receipt_conflict");
      yield* budget.reserve(request("two"));
      yield* budget.beginDispatch("two");
      expect((yield* Effect.flip(budget.settle({ ...receipt, requestId: "two" }))).reason).toBe(
        "receipt_conflict",
      );
      expect(yield* budget.snapshot).toMatchObject({ spentMicroUsd: 20_000, heldMicroUsd: 10_000 });
      yield* fill(9);
      expect((yield* Effect.flip(budget.reserve(request("three", 80_000)))).reason).toBe(
        "budget_exhausted",
      );
    }).pipe(Effect.provide(memory)),
);

it.effect(
  "records real overruns and stops admission and reserved dispatch even on following days",
  () =>
    Effect.gen(function* () {
      const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
      yield* budget.reserve(request("overrun"));
      yield* budget.reserve(request("waiting"));
      yield* budget.beginDispatch("overrun");
      yield* budget.settle({
        requestId: "overrun",
        receiptId: "overcharged",
        actualMicroUsd: 11_000,
      });
      expect(yield* budget.snapshot).toMatchObject({
        spentMicroUsd: 11_000,
        halted: true,
        availableMicroUsd: 0,
      });
      expect(yield* budget.beginDispatch("waiting")).toBe(false);
      yield* TestClock.adjust("2 days");
      expect((yield* Effect.flip(budget.reserve(request("later")))).reason).toBe(
        "budget_exhausted",
      );
      expect(yield* budget.snapshot).toMatchObject({ halted: true, availableMicroUsd: 0 });
    }).pipe(Effect.provide(memory)),
);

it.effect("rejects invalid money and cannot settle a request that was never sent", () =>
  Effect.gen(function* () {
    const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
    for (const invalid of [-1, 0, 0.5, NaN, Infinity, 100_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect((yield* Effect.flip(budget.reserve(request("invalid", invalid)))).reason).toBe(
        "invalid_input",
      );
    }
    yield* budget.reserve(request("unsent"));
    expect(
      (yield* Effect.flip(
        budget.settle({ requestId: "unsent", receiptId: "r", actualMicroUsd: 0 }),
      )).reason,
    ).toBe("invalid_transition");
    yield* budget.beginDispatch("unsent");
    expect(
      (yield* Effect.flip(
        budget.settle({ requestId: "unsent", receiptId: "r", actualMicroUsd: NaN }),
      )).reason,
    ).toBe("invalid_input");
    yield* budget.settle({ requestId: "unsent", receiptId: "r", actualMicroUsd: 0 });
    expect(yield* budget.snapshot).toMatchObject({ spentMicroUsd: 0, heldMicroUsd: 0 });
  }).pipe(Effect.provide(memory)),
);

it.effect(
  "retains reservations on disk and admits safely through separate SQLite connections",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-budget-" });
      const filename = `${directory}/budget.sqlite`;
      const initialize = SqlitePersistence.makeSqlitePersistenceLive(filename);
      yield* Effect.gen(function* () {
        const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
        yield* fill(9);
        yield* budget.reserve(request("crash", 60_000));
        yield* budget.beginDispatch("crash");
      }).pipe(Effect.provide(SelectionBudgetStore.layer.pipe(Layer.provide(initialize))));
      const connection = () =>
        SelectionBudgetStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename })));
      const results = yield* Effect.all(
        ["client-a", "client-b"].map((id) =>
          Effect.gen(function* () {
            const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
            expect(yield* budget.beginDispatch("crash")).toBe(false);
            return yield* Effect.result(budget.reserve(request(id, 30_000)));
          }).pipe(Effect.provide(connection())),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
      const reopened = yield* Effect.gen(function* () {
        return yield* (yield* SelectionBudgetStore.SelectionBudgetStore).snapshot;
      }).pipe(Effect.provide(connection()));
      expect(reopened).toMatchObject({
        heldMicroUsd: 990_000,
        unresolvedRequests: 1,
        availableMicroUsd: 10_000,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("recovers saved advice and unresolved state after closing and reopening SQLite", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-recovery-" });
    const filename = `${directory}/recovery.sqlite`;
    const advice = {
      requestId: "saved",
      receiptId: "receipt-saved",
      model: "typesafe/jev-1.13-20260917",
      costMicroUsd: 20,
      inputTokens: 476,
      capability: "standard",
      effort: "low",
      skillName: null,
      confidence: { capability: 1, effort: 1, skill: 1 },
    } as const;
    yield* Effect.gen(function* () {
      const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
      yield* budget.reserve(request("saved"));
      yield* budget.beginDispatch("saved");
      yield* budget.settle({
        requestId: advice.requestId,
        receiptId: advice.receiptId,
        actualMicroUsd: 20,
        advice,
      });
      yield* budget.reserve(request("lost"));
      yield* budget.beginDispatch("lost");
    }).pipe(
      Effect.provide(
        SelectionBudgetStore.layer.pipe(
          Layer.provide(SqlitePersistence.makeSqlitePersistenceLive(filename)),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const budget = yield* SelectionBudgetStore.SelectionBudgetStore;
      expect(yield* budget.inspect("saved", request("saved").fingerprint)).toEqual({
        requestId: "saved",
        state: "settled",
        advice,
      });
      expect(yield* budget.inspect("lost", request("lost").fingerprint)).toEqual({
        requestId: "lost",
        state: "dispatched",
        advice: null,
      });
      expect((yield* Effect.flip(budget.inspect("saved", "b".repeat(64)))).reason).toBe(
        "request_conflict",
      );
      expect(yield* budget.snapshot).toMatchObject({ spentMicroUsd: 20, heldMicroUsd: 10_000 });
    }).pipe(
      Effect.provide(
        SelectionBudgetStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename }))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
