import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type {
  ModelSelection,
  RouteQualification,
  RouteQualificationReason,
  ServerProvider,
} from "@t3tools/contracts";
import { IsoDateTime } from "@t3tools/contracts";
import { previewRouting } from "./routingPolicy.ts";

const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 10_000_000 }),
);
const receipt = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const microUsd = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
// Internal evidence from a trusted verifier, never a client-authored attestation.
export const QualificationEvidence = Schema.Struct({
  checkedAt: IsoDateTime,
  // Older records decode, but cannot become eligible without these explicit proofs.
  executionPath: Schema.optionalKey(Schema.Literals(["provider_harness", "direct_api"])),
  resolvedModel: Schema.optionalKey(receipt),
  priceCheckedAt: Schema.optionalKey(IsoDateTime),
  catalogReceipt: receipt,
  toolReceipt: Schema.NullOr(receipt),
  capabilityReceipt: Schema.NullOr(receipt),
  contextTokens: Schema.NullOr(count),
  billing: Schema.Literals(["subscription", "free", "metered", "unknown"]),
  billingReceipt: Schema.NullOr(receipt),
  inputMicroUsdPerMillion: Schema.NullOr(microUsd),
  outputMicroUsdPerMillion: Schema.NullOr(microUsd),
  requestMicroUsd: Schema.NullOr(microUsd),
  spendingGuardReceipt: Schema.NullOr(receipt),
});
export type QualificationEvidence = typeof QualificationEvidence.Type;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encode(value)).digest("hex");
export const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60_000;
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
export function qualificationBinding(
  provider: ServerProvider,
  selection: ModelSelection,
  configuration: unknown,
): string | null {
  if (provider.instanceId !== selection.instanceId || provider.auth.status !== "authenticated")
    return null;
  const identity = [
    provider.usageLimits?.credentialFingerprint ?? null,
    provider.auth.profileId ?? null,
    provider.auth.email?.trim().toLowerCase() ?? null,
  ];
  if (!identity.some(Boolean)) return null;
  const model = provider.models.find((m) => m.slug === selection.model);
  if (!model) return null;
  // Keep identity and configuration (which may contain secrets) out of logs and client responses.
  return hash([
    "qualification-v1",
    provider.instanceId,
    provider.driver,
    identity,
    provider.version,
    configuration,
    model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}
export function inspectQualification(input: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  binding: string | null;
  stored: { binding: string; evidence: QualificationEvidence } | null;
  now: number;
}): RouteQualification {
  const { selection, stored, now } = input;
  const provider = input.providers.find((p) => p.instanceId === selection.instanceId);
  const reasons: RouteQualificationReason[] = [];
  const add = (reason: RouteQualificationReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    provider.availability === "unavailable"
  )
    add("provider_unavailable");
  if (!input.binding) add("identity_unverified");
  if (!provider?.models.some((m) => m.slug === selection.model)) add("model_unavailable");
  const snapshotAge = now - Date.parse(provider?.checkedAt ?? "");
  if (!Number.isFinite(snapshotAge) || snapshotAge < 0 || snapshotAge > MAX_SNAPSHOT_AGE_MS)
    add("snapshot_stale");
  if (!stored) add("evidence_missing");
  if (stored && stored.binding !== input.binding) add("binding_changed");
  const evidence = stored?.evidence;
  if (evidence) {
    const age = now - Date.parse(evidence.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_EVIDENCE_AGE_MS) add("evidence_stale");
    if (!evidence.toolReceipt) add("tools_unverified");
    if (evidence.executionPath !== "provider_harness") add("harness_unverified");
    if (evidence.resolvedModel !== selection.model) add("model_resolution_unverified");
    if (!evidence.contextTokens) add("context_unverified");
    if (!evidence.capabilityReceipt) add("capability_unverified");
    if (!evidence.billingReceipt || evidence.billing === "unknown") add("billing_unverified");
    if (evidence.billing === "metered") add("paid_execution_disabled");
    if (evidence.billing === "free") {
      const priceAge = now - Date.parse(evidence.priceCheckedAt ?? "");
      if (!Number.isFinite(priceAge) || priceAge < 0 || priceAge > MAX_SNAPSHOT_AGE_MS)
        add("price_stale");
    }
    if (!evidence.spendingGuardReceipt) add("spending_guard_unverified");
    if (
      evidence.billing === "free" &&
      [
        evidence.inputMicroUsdPerMillion,
        evidence.outputMicroUsdPerMillion,
        evidence.requestMicroUsd,
      ].some((price) => price !== 0)
    )
      add("billing_unverified");
    if (evidence.billing === "subscription") {
      const account = previewRouting(
        input.providers,
        { instanceId: selection.instanceId, task: "", cwd: null },
        now,
      ).accounts.find((a) => a.instanceId === selection.instanceId);
      if (account?.reason !== "available") add("quota_unavailable");
    }
  }
  const currentEvidence =
    evidence && stored?.binding === input.binding && !reasons.includes("evidence_stale")
      ? evidence
      : null;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    state: reasons.length ? "blocked" : "evidence_ready",
    reasons,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    evidenceCheckedAt: evidence?.checkedAt ?? null,
    contextTokens: currentEvidence?.contextTokens ?? null,
    billing: currentEvidence?.billing ?? "unknown",
    automaticExecution: false,
  };
}
