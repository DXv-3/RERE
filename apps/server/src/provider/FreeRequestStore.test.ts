import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as Store from "./FreeRequestStore.ts";
const claim = {
  requestKey: "a".repeat(64),
  routeKey: "b".repeat(64),
  requestHash: "c".repeat(64),
  instanceId: "instance",
  sessionId: "session",
  model: "test/model:free",
  endpoint: "test/provider",
  requestedFields: ["input", "tools"],
};
const receipt: Store.FreeReceipt = {
  requestHash: claim.requestHash,
  model: claim.model,
  responseId: "receipt",
  cost: 0,
  state: "completed_free",
  httpStatus: 200,
  failure: null,
};
const layer = Store.layer.pipe(Layer.provideMerge(Sqlite.SqlitePersistenceMemory));
it.effect("arbitrates concurrent requests and aliases without repeating a completed payload", () =>
  Effect.gen(function* () {
    const store = yield* Store.FreeRequestStore;
    const claims = yield* Effect.all(
      [
        store.begin(claim),
        store.begin({ ...claim, requestKey: "d".repeat(64), instanceId: "alias" }),
      ],
      { concurrency: "unbounded" },
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const index = claims.findIndex(Boolean);
    const winner =
      index === 0 ? claim : { ...claim, requestKey: "d".repeat(64), instanceId: "alias" };
    yield* store.settle(winner.requestKey, claims[index]!, receipt);
    expect(yield* store.begin(winner)).toBeNull();
    expect(
      yield* store.begin({ ...claim, requestKey: "e".repeat(64), sessionId: "new-session" }),
    ).not.toBeNull();
  }).pipe(Effect.provide(layer)),
);
it.effect("uncertain outcomes block other sessions and models on the same credential binding", () =>
  Effect.gen(function* () {
    const store = yield* Store.FreeRequestStore;
    const token = yield* store.begin(claim);
    yield* store.settle(claim.requestKey, token!, {
      ...receipt,
      cost: null,
      state: "uncertain",
      httpStatus: 404,
      failure: "unsupported_parameters",
    });
    expect(
      yield* store.begin({
        ...claim,
        requestKey: "d".repeat(64),
        sessionId: "restart",
        model: "test/other:free",
      }),
    ).toBeNull();
    expect((yield* store.read(claim.requestKey))?.receipt?.failure).toBe("unsupported_parameters");
  }).pipe(Effect.provide(layer)),
);
it.effect("requires original ownership, exact model and valid zero-cost receipts", () =>
  Effect.gen(function* () {
    const store = yield* Store.FreeRequestStore;
    const token = yield* store.begin(claim);
    expect((yield* Effect.flip(store.settle(claim.requestKey, "wrong", receipt))).reason).toBe(
      "conflict",
    );
    expect(
      (yield* Effect.flip(
        store.settle(claim.requestKey, token!, { ...receipt, model: "wrong/model:free" }),
      )).reason,
    ).toBe("conflict");
    for (const changed of [
      { cost: 0.1 },
      { cost: -1 },
      { cost: Number.NaN },
      { responseId: null },
      { httpStatus: 201 },
    ])
      expect(
        (yield* Effect.flip(store.settle(claim.requestKey, token!, { ...receipt, ...changed })))
          .reason,
      ).toBe("invalid");
    expect((yield* store.read(claim.requestKey))?.state).toBe("dispatched");
  }).pipe(Effect.provide(layer)),
);
it.effect("settlement is idempotent but uncertainty cannot be silently upgraded", () =>
  Effect.gen(function* () {
    const store = yield* Store.FreeRequestStore;
    const token = yield* store.begin(claim);
    const uncertain = {
      ...receipt,
      state: "uncertain" as const,
      cost: null,
      failure: "transport_or_receipt" as const,
    };
    yield* store.settle(claim.requestKey, token!, uncertain);
    yield* store.settle(claim.requestKey, token!, uncertain);
    expect((yield* Effect.flip(store.settle(claim.requestKey, token!, receipt))).reason).toBe(
      "conflict",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect("persists crash holds and completed receipts across file-backed database reopening", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-free-ledger-" });
    const persistence = Sqlite.makeSqlitePersistenceLive(`${directory}/state.sqlite`);
    const persisted = Store.layer.pipe(Layer.provide(persistence));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store.FreeRequestStore;
        const token = yield* store.begin(claim);
        yield* store.settle(claim.requestKey, token!, receipt);
        yield* store.begin({ ...claim, requestKey: "d".repeat(64) });
      }).pipe(Effect.provide(persisted)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store.FreeRequestStore;
        expect((yield* store.read(claim.requestKey))?.receipt).toEqual(receipt);
        expect((yield* store.read("d".repeat(64)))?.state).toBe("dispatched");
        expect(
          yield* store.begin({ ...claim, requestKey: "e".repeat(64), sessionId: "restarted" }),
        ).toBeNull();
      }).pipe(Effect.provide(persisted)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("stores field names and hashes rather than prompts or credentials", () =>
  Effect.gen(function* () {
    const store = yield* Store.FreeRequestStore;
    yield* store.begin(claim);
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      requested_fields: string;
      request_hash: string;
    }>`SELECT requested_fields,request_hash FROM workbench_free_requests`;
    expect(row?.requested_fields).toBe('["input","tools"]');
    expect(row?.request_hash).toBe(claim.requestHash);
    expect(
      yield* Effect.flip(
        store.begin({ ...claim, requestedFields: ["prompt content would be rejected"] }),
      ),
    ).toMatchObject({ reason: "invalid" });
  }).pipe(Effect.provide(layer)),
);
