# Routing Program Design

Status: Ryan authorized the reviewed build on October 3. Implementation begins with advisory routing. Default recommendation: Jev-assisted decisions inside Workbench, manual mode preserved, recommendations first, Jev selection capped at $0.10/day once durable enforcement exists, and paid automatic task execution disabled.

## Core Types

Use Effect Schema contracts and existing branded provider/thread/run IDs. The following describes the later execution design. The implemented read-only advisory contract is authoritative in packages/contracts/src/routing.ts; it accepts an exact provider instance, bounded draft text and project directory, and returns local allowance/skill suggestions. It does not implement the prepare, reserve, apply or settle operations below.

```ts
type RoutingMode = "manual" | "recommend" | "auto";
type QuotaState = "fresh" | "stale" | "unsupported" | "failed";
type RouteReason =
  | "manual_pin"
  | "subscription_headroom"
  | "free_eligible"
  | "capability_required"
  | "budget_blocked"
  | "quota_unknown"
  | "quota_exhausted"
  | "context_insufficient"
  | "judgment_unavailable"
  | "identity_unverified"
  | "no_eligible_route";

interface RoutingPolicy {
  version: number;
  mode: RoutingMode;
  allowedAccountKeys: readonly string[];
  allowedModelIds: readonly string[];
  reservePercent: number;
  dailyCapMicroUsd: number; // integer; selection and execution budgets stay separate
  monthlyCapMicroUsd: number;
  perTurnCapMicroUsd: number;
  allowExternalJudgment: boolean;
  executionPolicy: "subscriptions_only" | "free_only" | "mixed";
}
interface RouteCandidate {
  providerInstanceId: ProviderInstanceId;
  accountKey: string;
  identityVerified: boolean;
  modelId: string;
  supportedEfforts: readonly string[];
  capabilities: readonly string[];
  contextTokens: number;
  quota: { state: QuotaState; checkedAt: string; windows: readonly UsageWindow[] };
  billing: "subscription" | "free" | "metered";
  boundedRequestCostMicroUsd: number | null;
  catalogRevision: string;
}
interface TaskJudgment {
  taskClass: "routine" | "implementation" | "investigation" | "architecture" | "unknown";
  capability: "basic" | "standard" | "advanced" | "unknown";
  effort: "low" | "medium" | "high" | "unknown";
  probabilities: Readonly<Record<string, Readonly<Record<string, number>>>>;
  modelVersion: string;
  costMicroUsd: number | null;
}
interface RoutingInput {
  threadId: ThreadId;
  runId: RunId;
  commandId: CommandId;
  revision: string;
  policyVersion: number;
}
interface RoutingDecision {
  id: string;
  input: RoutingInput;
  selected: RouteCandidate | null;
  effort: string | null;
  reasons: readonly RouteReason[];
  mode: RoutingMode;
  reservationId: string | null;
  state: "recommended" | "reserved" | "applied" | "blocked" | "settled";
}
```

Unknown prices/context/capabilities require explicit unavailable states in schemas; no fabricated zero/infinity defaults. Use the existing provider window type as `UsageWindow`. Reject negative, noninteger, or overflowing monetary values. An advertised model is not automatically qualified for every task class.

## Service And Function Signatures

```ts
// RoutingService: server-side state assembly; Effect errors are typed.
preview(input: RoutingInput): Effect<RoutingDecision, RoutingError>;
prepare(input: RoutingInput): Effect<RoutingDecision, RoutingError>;
settle(input: { decisionId: string; receiptId: string }): Effect<void, RoutingError>;
setPolicy(input: { scope: string; expectedVersion: number; policy: RoutingPolicy })
  : Effect<RoutingPolicy, RoutingError>;
listDecisions(input: { threadId: ThreadId; cursor?: string })
  : Effect<DecisionPage, RoutingError>;

// JevClient: bounded, cancellable, server-only; no automatic paid retry.
judge(input: RedactedTaskState, chargeId: string): Effect<TaskJudgment, JevError>;

// routingPolicy: pure functions; do not probe, fetch, or launch here.
eligible(input: EligibilityInput): EligibilityResult;
rank(input: RankingInput): RankedCandidates;
validateJudgment(input: unknown, expected: QuestionContract): Result<TaskJudgment, JudgmentError>;

// RoutingStore: durable decisions + transactional admission/reconciliation.
readDecision(runId: RunId): Effect<RoutingDecision | null, StoreError>;
recordRecommendation(decision: RoutingDecision): Effect<void, StoreError>;
reserve(input: ReservationInput): Effect<Reservation, BudgetOrStoreError>;
apply(input: { decisionId: string; expectedRevision: string }): Effect<RoutingDecision, StoreError>;
reconcile(input: { reservationId: string; receiptId: string; actualMicroUsd: number | null })
  : Effect<void, StoreError>;
```

Internal helpers remain local to these modules. `prepare` first reuses an existing durable result for the run, then checks current state and freshness. Preview never starts a coding turn; any paid judgment still needs budget admission. Applying a route and enqueueing provider-start must share the orchestration transaction, not two independent writes. Ambiguous external request outcomes retain a pending receipt and reservation; retries require reconciliation or an explicitly separate authorized attempt.

## End-To-End Trace

```text
existing authorized turn command
  Orchestrator validates mode and records routing effect (manual bypasses routing)
    EffectWorker -> RoutingService.prepare
      read server policy, candidates, identity and quota snapshot
      routingPolicy.eligible
      reserve bounded judgment cost, if Jev is allowed
      JevClient.judge; validate and reconcile judgment receipt
      routingPolicy.rank
      recheck thread/policy/account/catalog revisions
      RoutingStore.reserve; emit decision receipt
    Orchestrator applies receipt and queues provider-start atomically
      existing ContextHandoffService prepares required history
      ProviderTurnStartService checks active route and invokes adapter
        existing completion/checkpoint receipt
          RoutingService.settle -> receipt and cost reconciliation
          clients show actual account/model/effort, quota age and cost
```

Recommendation mode records the proposal without changing the selected provider. A user-selected override follows existing manual dispatch. Cancellation must end before dispatch or use existing turn interruption; it must not create another route on a second worker.

## File Map

New files:

- `packages/contracts/src/routing.ts`: versioned schemas, policy, receipts and transport inputs.
- `apps/server/src/routing/{RoutingService,RoutingStore,JevClient,routingPolicy}.ts`: services and pure policy above.
- Matching `*.test.ts` files: service behavior, malformed response, concurrency/replay, policy invariants.
- `apps/server/src/persistence/Migrations/<next>_WorkbenchRouting.ts`: transaction tables/indexes; assign next number at implementation.
- `apps/web/src/components/workbench/{RoutingControl,RoutingSettings}.tsx`: mode/override/status and budget controls; shared standard UI components.

Edits:

- `packages/contracts/src/{rpc,orchestrationV2}.ts`: typed RPC/decision receipts; follow existing contract exports.
- `apps/server/src/{ws,serverSettings}.ts`: thin handlers and settings integration.
- `apps/server/src/orchestration-v2/{Orchestrator,EffectOutbox,EffectWorker,ProviderTurnStartService}.ts`: durable routing effect before start, registration through existing service composition, revalidation, receipt application.
- `apps/server/src/orchestration-v2/{ContextHandoffService,ContextHandoffBudget}.ts`: extend coverage only where existing handoffs cannot retain required continuity; reuse first.
- `apps/web/src/components/{ChatView,settings/ProviderSettingsPanel}.tsx`: controls and distinct-account identity/setup state. The existing AddProviderInstanceDialog already permits multiple instances.
- `packages/client-runtime`: only shared transport/state adapter modules actually required by RPC consumers; identify exact modules during slice 0 before editing.

Do not alter provider global defaults. Desktop inherits server/web behavior; no extra native router. Unsupported mobile/old-client capability explicitly leaves routing manual. CLI/scheduled/agent paths use the same service and budget policy.

## Verification

1. Fake external judgments and provider adapters; prove preview through actual server contract to UI while manual dispatch stays unchanged.
2. Two provider IDs with one fingerprint count as one account; isolated Grok homes with distinct verified identities count as two. Missing identity cannot become an automatic fallback.
3. Unknown/stale/full quota, overlapping windows, future reset, 429 cooldown, unavailable tools, small context, and unknown price cannot escape eligibility. Model capability and effort compatibility use catalog facts.
4. Jev malformed enums, NaN/probabilities, timeout, cancellation and policy-revision races yield visible conservative results. No confidence threshold grants permission.
5. Parallel turns, worker replay, crashed workers, missing cost receipts and duplicate receipts cannot exceed admitted reservation totals or duplicate dispatch. Test at least two simultaneous clients.
6. Active tool side effects never rerun on another route; provider handoff retains original goal and pending approvals. No source credential or rejected imported instruction enters the capsule.
7. Golden tasks compare manual, deterministic and Jev recommendations. Live evaluation is explicitly bounded by the chosen paid cap. Report accepted-task outcome, total cost including Jev, and latency; do not equate typed output with correctness.
8. Integrated web/desktop/remote checks show true quota age and selection; settings, composer, scheduled work and older-client behavior agree. Disabling Auto restores manual selection without losing drafts/history.

Ryan chose a $0.10/day selection cap; paid automatic execution stays off. The advisory threshold is 10%, while the earlier 15% automatic-reserve proposal must be resolved before activation. Automatic cross-provider execution follows successful recommendation evaluation; the available browser-agent repository does not change this sequence.
