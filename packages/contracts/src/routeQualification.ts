import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const RouteQualificationReason = Schema.Literals([
  "provider_unavailable",
  "identity_unverified",
  "snapshot_stale",
  "model_unavailable",
  "evidence_missing",
  "evidence_stale",
  "binding_changed",
  "tools_unverified",
  "harness_unverified",
  "model_resolution_unverified",
  "price_stale",
  "context_unverified",
  "billing_unverified",
  "paid_execution_disabled",
  "spending_guard_unverified",
  "quota_unavailable",
  "capability_unverified",
  "storage_unavailable",
]);
export type RouteQualificationReason = typeof RouteQualificationReason.Type;
export const RouteQualification = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.String,
  state: Schema.Literals(["blocked", "evidence_ready"]),
  reasons: Schema.Array(RouteQualificationReason),
  checkedAt: Schema.String,
  evidenceCheckedAt: Schema.NullOr(Schema.String),
  contextTokens: Schema.NullOr(Schema.Number),
  billing: Schema.Literals(["subscription", "free", "metered", "unknown"]),
  automaticExecution: Schema.Literal(false),
});
export type RouteQualification = typeof RouteQualification.Type;
