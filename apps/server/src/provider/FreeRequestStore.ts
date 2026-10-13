import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const FreeReceipt = Schema.Struct({
  requestHash: Schema.String,
  model: Schema.NullOr(Schema.String),
  responseId: Schema.NullOr(Schema.String),
  cost: Schema.NullOr(Schema.Number),
  state: Schema.Literals(["completed_free", "uncertain"]),
  httpStatus: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(
    Schema.Literals([
      "unsupported_parameters",
      "no_endpoint",
      "rate_limited",
      "authentication",
      "upstream_error",
      "transport_or_receipt",
    ]),
  ),
});
export type FreeReceipt = typeof FreeReceipt.Type;
type Claim = {
  requestKey: string;
  routeKey: string;
  requestHash: string;
  instanceId: string;
  sessionId: string;
  model: string;
  endpoint: string;
  requestedFields: readonly string[];
};
export class FreeRequestError extends Schema.TaggedError<FreeRequestError>()("FreeRequestError", {
  reason: Schema.Literals(["storage", "invalid", "conflict"]),
}) {}
export class FreeRequestStore extends Context.Service<
  FreeRequestStore,
  {
    readonly begin: (input: Claim) => Effect.Effect<string | null, FreeRequestError>;
    readonly settle: (
      key: string,
      token: string,
      receipt: FreeReceipt,
    ) => Effect.Effect<void, FreeRequestError>;
    readonly read: (
      key: string,
    ) => Effect.Effect<{ state: string; receipt: FreeReceipt | null } | null, FreeRequestError>;
  }
>()("t3/provider/FreeRequestStore") {}
const encodeFields = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(FreeReceipt));
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(FreeReceipt));
const storage = () => new FreeRequestError({ reason: "storage" });
const digest = (s: string) => /^[a-f0-9]{64}$/.test(s);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const begin = Effect.fn("FreeRequestStore.begin")(function* (input: Claim) {
    if (
      ![input.requestKey, input.routeKey, input.requestHash].every(digest) ||
      [input.instanceId, input.sessionId, input.model, input.endpoint].some(
        (v) => !v || v.length > 256,
      ) ||
      input.requestedFields.length > 32 ||
      input.requestedFields.some((v) => !/^[a-z_]{1,40}$/.test(v))
    )
      return yield* new FreeRequestError({ reason: "invalid" });
    const token = NodeCrypto.randomUUID();
    const now = yield* Clock.currentTimeMillis;
    // One atomic write arbitrates concurrent processes and aliases. Never age
    // out a possibly sent request: a restart is not evidence of zero cost.
    const rows = yield* sql`INSERT INTO workbench_free_requests
      (request_key,route_key,claim_token,instance_id,session_id,request_hash,model,endpoint,requested_fields,state,claimed_at)
      SELECT ${input.requestKey},${input.routeKey},${token},${input.instanceId},${input.sessionId},${input.requestHash},${input.model},${input.endpoint},${encodeFields([...input.requestedFields].sort())},'dispatched',${now}
      WHERE (SELECT count(*) FROM workbench_free_requests) < 100000
        AND NOT EXISTS (SELECT 1 FROM workbench_free_requests WHERE route_key=${input.routeKey} AND state != 'completed_free')
      ON CONFLICT(request_key) DO NOTHING RETURNING request_key`.pipe(Effect.mapError(storage));
    return rows.length ? token : null;
  });
  const read = Effect.fn("FreeRequestStore.read")(function* (key: string) {
    const [row] = yield* sql<{
      state: string;
      receipt_json: string | null;
    }>`SELECT state,receipt_json FROM workbench_free_requests WHERE request_key=${key}`.pipe(
      Effect.mapError(storage),
    );
    return row
      ? {
          state: row.state,
          receipt:
            row.receipt_json === null
              ? null
              : yield* decodeReceipt(row.receipt_json).pipe(Effect.mapError(storage)),
        }
      : null;
  });
  const settle = Effect.fn("FreeRequestStore.settle")(function* (
    key: string,
    token: string,
    receipt: FreeReceipt,
  ) {
    if (
      !digest(receipt.requestHash) ||
      (receipt.model?.length ?? 0) > 256 ||
      (receipt.responseId?.length ?? 0) > 256 ||
      (receipt.cost !== null && (!Number.isFinite(receipt.cost) || receipt.cost < 0)) ||
      (receipt.state === "completed_free" &&
        (receipt.cost !== 0 ||
          !receipt.responseId ||
          !receipt.model ||
          receipt.httpStatus !== 200 ||
          receipt.failure !== null))
    )
      return yield* new FreeRequestError({ reason: "invalid" });
    const encoded = yield* encodeReceipt(receipt).pipe(
      Effect.mapError(() => new FreeRequestError({ reason: "invalid" })),
    );
    const now = yield* Clock.currentTimeMillis;
    const rows =
      yield* sql`UPDATE workbench_free_requests SET state=${receipt.state},receipt_json=${encoded},settled_at=${now}
      WHERE request_key=${key} AND claim_token=${token} AND request_hash=${receipt.requestHash}
        AND (${receipt.state} != 'completed_free' OR model=${receipt.model})
        AND (state='dispatched' OR receipt_json=${encoded}) RETURNING request_key`.pipe(
        Effect.mapError(storage),
      );
    if (!rows.length) return yield* new FreeRequestError({ reason: "conflict" });
  });
  return FreeRequestStore.of({ begin, settle, read });
});
export const layer = Layer.effect(FreeRequestStore, make);
