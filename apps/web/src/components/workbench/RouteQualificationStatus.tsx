import type { RouteQualification, RouteQualificationReason } from "@t3tools/contracts";
const labels: Record<RouteQualificationReason, string> = {
  provider_unavailable: "Provider is not ready or is disabled.",
  identity_unverified: "Exact account identity is not verified.",
  snapshot_stale: "Provider status needs refreshing.",
  model_unavailable: "This exact model is not in the provider catalog.",
  evidence_missing:
    "Verified tool, context, capability and billing evidence has not been recorded for this selection.",
  evidence_stale: "Qualification evidence has expired or its timestamp is invalid.",
  binding_changed: "Account, configuration, runtime or model options changed since verification.",
  tools_unverified: "Successful tool execution has not been verified.",
  harness_unverified: "Tool execution through this coding provider has not been verified.",
  model_resolution_unverified:
    "The model that actually answered has not been verified as this exact selection.",
  price_stale: "Free-model prices need fresh verification.",
  context_unverified: "Context capacity has not been verified.",
  billing_unverified: "Billing and prices have not been verified.",
  paid_execution_disabled: "Paid automatic task execution is disabled.",
  spending_guard_unverified: "Protection against paid overage or fallback has not been verified.",
  quota_unavailable: "A fresh subscription allowance above the reserve is required.",
  capability_unverified: "Task capability has not been evaluated.",
  storage_unavailable: "Qualification evidence could not be checked.",
};
export function RouteQualificationStatus({ qualification }: { qualification: RouteQualification }) {
  return (
    <section aria-label="Model Routing Readiness">
      <h3>Model Routing Readiness</h3>
      <p>
        {qualification.model} · {qualification.instanceId}
      </p>
      <p>
        {qualification.state === "evidence_ready"
          ? "Evidence is current. Turn-specific context and task fit still need checking."
          : "This selection is not qualified for automatic routing."}
      </p>
      <ul>
        {qualification.reasons.map((reason) => (
          <li key={reason}>{labels[reason]}</li>
        ))}
      </ul>
      {qualification.evidenceCheckedAt && (
        <p>Evidence reported {new Date(qualification.evidenceCheckedAt).toLocaleString()}.</p>
      )}
      <p>
        Automatic execution remains off. This check makes no inference request and does not change
        your manual model.
      </p>
    </section>
  );
}
