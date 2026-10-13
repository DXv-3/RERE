import type { ModelSelection } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { QualificationEvidence, MAX_EVIDENCE_AGE_MS } from "./qualificationPolicy.ts";
export class QualificationStoreError extends Schema.TaggedError<QualificationStoreError>()(
  "QualificationStoreError",
  {
    reason: Schema.Literals(["invalid_evidence", "storage", "capacity"]),
  },
) {}
type Stored = { binding: string; evidence: QualificationEvidence };
export class RouteQualificationStore extends Context.Service<
  RouteQualificationStore,
  {
    readonly read: (
      selection: ModelSelection,
    ) => Effect.Effect<Stored | null, QualificationStoreError>;
    // Only trusted server verifiers may write evidence. Deliberately not exposed over RPC.
    readonly record: (
      selection: ModelSelection,
      input: Stored,
    ) => Effect.Effect<void, QualificationStoreError>;
    readonly revoke: (selection: ModelSelection) => Effect.Effect<void, QualificationStoreError>;
  }
>()("t3/routing/RouteQualificationStore") {}
const encode = Schema.encodeEffect(Schema.fromJsonString(QualificationEvidence));
const decode = Schema.decodeEffect(Schema.fromJsonString(QualificationEvidence));
const validate = Schema.decodeUnknownEffect(QualificationEvidence);
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const key = (selection: ModelSelection) =>
  NodeCrypto.createHash("sha256")
    .update(encodeOptions([...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id))))
    .digest("hex");
const storage = () => new QualificationStoreError({ reason: "storage" });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("RouteQualificationStore.read")(function* (selection: ModelSelection) {
    const [row] = yield* sql<{
      binding: string;
      evidence_json: string;
    }>`SELECT binding,evidence_json FROM workbench_route_qualifications
      WHERE instance_id=${selection.instanceId} AND model_id=${selection.model} AND selection_key=${key(selection)}`.pipe(
      Effect.mapError(storage),
    );
    if (!row) return null;
    return {
      binding: row.binding,
      evidence: yield* decode(row.evidence_json).pipe(Effect.mapError(storage)),
    };
  });
  const record = Effect.fn("RouteQualificationStore.record")(function* (
    selection: ModelSelection,
    input: Stored,
  ) {
    const evidence = yield* validate(input.evidence).pipe(
      Effect.mapError(() => new QualificationStoreError({ reason: "invalid_evidence" })),
    );
    const now = yield* Clock.currentTimeMillis;
    const age = now - Date.parse(evidence.checkedAt);
    if (
      !/^[a-f0-9]{64}$/.test(input.binding) ||
      selection.model.length > 256 ||
      (selection.options?.length ?? 0) > 16 ||
      new Set(selection.options?.map((o) => o.id)).size !== (selection.options?.length ?? 0) ||
      age < 0 ||
      age > MAX_EVIDENCE_AGE_MS
    )
      return yield* new QualificationStoreError({ reason: "invalid_evidence" });
    const body = yield* encode(evidence).pipe(Effect.mapError(storage));
    const rows =
      yield* sql`INSERT INTO workbench_route_qualifications(instance_id,model_id,selection_key,binding,evidence_json)
      SELECT ${selection.instanceId},${selection.model},${key(selection)},${input.binding},${body}
      WHERE (SELECT count(*) FROM workbench_route_qualifications) < 4096 OR EXISTS (
        SELECT 1 FROM workbench_route_qualifications WHERE instance_id=${selection.instanceId} AND model_id=${selection.model} AND selection_key=${key(selection)})
      ON CONFLICT(instance_id,model_id,selection_key) DO UPDATE SET binding=excluded.binding,evidence_json=excluded.evidence_json
      WHERE julianday(json_extract(excluded.evidence_json,'$.checkedAt')) >= julianday(json_extract(workbench_route_qualifications.evidence_json,'$.checkedAt'))
      RETURNING instance_id`.pipe(Effect.mapError(storage));
    if (rows.length === 0 && !(yield* read(selection)))
      return yield* new QualificationStoreError({ reason: "capacity" });
  });
  const revoke = Effect.fn("RouteQualificationStore.revoke")(function* (selection: ModelSelection) {
    yield* sql`DELETE FROM workbench_route_qualifications WHERE instance_id=${selection.instanceId} AND model_id=${selection.model} AND selection_key=${key(selection)}`.pipe(
      Effect.mapError(storage),
    );
  });
  return RouteQualificationStore.of({ read, record, revoke });
});
export const layer = Layer.effect(RouteQualificationStore, make);
