import * as Schema from "effect/Schema";
import { ManagedSkillCandidate } from "./managedSkills.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RouteQualification } from "./routeQualification.ts";
import { RoutingLadder, RoutingMode, RoutingPreference, SkillListing } from "./settings.ts";

export const RoutingPreviewInput = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  instanceId: Schema.NullOr(ProviderInstanceId),
  task: Schema.String.check(Schema.isMaxLength(4_000)),
  cwd: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
  /** Also return the router's recent picks for this thread. */
  threadId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type RoutingPreviewInput = typeof RoutingPreviewInput.Type;

export const RoutingAccountReason = Schema.Literals([
  "available",
  "disabled",
  "unavailable",
  "sign_in_required",
  "identity_unknown",
  "quota_unknown",
  "quota_failed",
  "quota_stale",
  "quota_reserved",
  "no_models",
  "shared_account",
]);
export type RoutingAccountReason = typeof RoutingAccountReason.Type;

export const SelectionBudgetSnapshot = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unavailable") }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    timeZone: Schema.String,
    day: Schema.String,
    capMicroUsd: Schema.Number,
    spentMicroUsd: Schema.Number,
    heldMicroUsd: Schema.Number,
    availableMicroUsd: Schema.Number,
    unresolvedRequests: Schema.Number,
    halted: Schema.Boolean,
  }),
]);
export type SelectionBudgetSnapshot = typeof SelectionBudgetSnapshot.Type;

const RoutingCapability = Schema.Literals(["basic", "standard", "advanced", "unknown"]);
const RoutingEffort = Schema.Literals(["low", "medium", "high", "unknown"]);
const probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const JevAdvice = Schema.Struct({
  requestId: Schema.String,
  receiptId: Schema.String,
  model: Schema.String,
  costMicroUsd: Schema.Number,
  inputTokens: Schema.Number,
  capability: RoutingCapability,
  effort: RoutingEffort,
  skillName: Schema.NullOr(Schema.String),
  /** Every skill Jev rated relevant, best first. Older stored advice has only `skillName`. */
  skillNames: Schema.optional(Schema.Array(Schema.String)),
  confidence: Schema.Struct({ capability: probability, effort: probability, skill: probability }),
});
export type JevAdvice = typeof JevAdvice.Type;
// Omitted by older servers; null means recovery is unavailable, never a fresh request.
export const JevRequest = Schema.Struct({
  requestId: Schema.String,
  state: Schema.Literals(["new", "reserved", "dispatched", "settled", "released"]),
  advice: Schema.NullOr(JevAdvice),
});
export type JevRequest = typeof JevRequest.Type;

/** One router pick for a sent message. `applied` is false in shadow mode. */
export const RoutingDecision = Schema.Struct({
  commandId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.optional(Schema.String),
  decidedAt: Schema.String,
  mode: RoutingMode,
  judge: Schema.Literals(["jev", "local", "reused"]),
  capability: RoutingCapability,
  effort: RoutingEffort,
  fromInstanceId: ProviderInstanceId,
  fromModel: Schema.String,
  fromEffort: Schema.NullOr(Schema.String),
  toInstanceId: ProviderInstanceId,
  toModel: Schema.String,
  toModelName: Schema.optional(Schema.String),
  toEffort: Schema.NullOr(Schema.String),
  applied: Schema.Boolean,
  reason: Schema.String,
  /** The managed skill Auto attached to the message, when it attached one. */
  skillName: Schema.optional(Schema.String),
  /** Every managed skill Auto attached, when it attached more than one. */
  skillNames: Schema.optional(Schema.Array(Schema.String)),
  /** Set when the next message in the thread was hand-picked onto another model. */
  overridden: Schema.Boolean,
});
export type RoutingDecision = typeof RoutingDecision.Type;

/** Threads Auto moved one way, the tokens they then ran, and what that was worth. */
const RoutingSavingsSide = Schema.Struct({
  threads: Schema.Number,
  /** Tokens those threads ran on the model Auto picked. A floor: see `RoutingSavings`. */
  tokens: Schema.Number,
  /**
   * The difference at list prices between the model the thread arrived on and the one Auto
   * picked, in millionths of a dollar.
   */
  microUsd: Schema.Number,
});

/**
 * What Auto's picks were worth, counted only from picks that were applied, changed the model, and
 * were not moved back by hand. Token counts are a floor: a turn reports the size of its last
 * request, not every request it made while using tools.
 */
export const RoutingSavings = Schema.Struct({
  /** Moved to a cheaper model. `microUsd` is what that saved. */
  lighter: RoutingSavingsSide,
  /** Moved to a dearer model. `microUsd` is what that cost. */
  stronger: RoutingSavingsSide,
  /** Moves left out of both sides because one of the two models has no known price. */
  unpricedThreads: Schema.Number,
  /** What Jev itself has been paid for judging. */
  jevMicroUsd: Schema.Number,
  /** When the earliest counted pick was made; null when none has been. */
  since: Schema.NullOr(Schema.String),
});
export type RoutingSavings = typeof RoutingSavings.Type;

export const RoutingScorecard = Schema.Struct({
  total: Schema.Number,
  /** Decisions whose pick differed from the model the message arrived with. */
  changed: Schema.Number,
  overridden: Schema.Number,
  recent: Schema.Array(RoutingDecision),
  savings: Schema.optional(RoutingSavings),
});
export type RoutingScorecard = typeof RoutingScorecard.Type;

/**
 * What Auto would start a new thread on for the typed task, worked out with the same rules the
 * send uses and without a paid request. `jev` means an already-recovered Jev judgment was used;
 * `local` means built-in rules only, which Jev may still refine when the message is sent.
 */
export const RoutingPrediction = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.String,
  modelName: Schema.String,
  effort: Schema.NullOr(Schema.String),
  basis: Schema.Literals(["local", "jev"]),
});
export type RoutingPrediction = typeof RoutingPrediction.Type;

export const RoutingPreview = Schema.Struct({
  /** Present when Auto is on and the request named the model the message would start on. */
  predicted: Schema.optional(RoutingPrediction),
  qualification: Schema.optional(RouteQualification),
  checkedAt: Schema.String,
  mode: Schema.Literals(["advisory", "shadow", "automatic"]),
  automaticExecution: Schema.Boolean,
  judge: Schema.Literal("local"),
  scorecard: Schema.optional(RoutingScorecard),
  threadDecisions: Schema.optional(Schema.Array(RoutingDecision)),
  preference: Schema.optional(RoutingPreference),
  pacing: Schema.optional(Schema.Boolean),
  /** `selected` when sessions list no skills and each message carries its own. */
  skillListing: Schema.optional(SkillListing),
  /** Weekly usage against the calendar for the selected account, when it reports both. */
  pace: Schema.optional(
    Schema.NullOr(Schema.Struct({ usedPercent: Schema.Number, elapsedPercent: Schema.Number })),
  ),
  /** Ladders the user has set; sent back whole when one changes. */
  ladders: Schema.optional(Schema.Record(ProviderInstanceId, RoutingLadder)),
  managedSkills: Schema.optional(Schema.Array(ManagedSkillCandidate)),
  managedCatalogAvailable: Schema.optional(Schema.Boolean),
  starterSkillsAvailable: Schema.optional(Schema.Boolean),
  jevRequest: Schema.optional(Schema.NullOr(JevRequest)),
  jevConfigured: Schema.optional(Schema.Boolean),
  selectionBudget: Schema.optional(SelectionBudgetSnapshot),
  reservePercent: Schema.Number,
  recommendedInstanceId: Schema.NullOr(ProviderInstanceId),
  accounts: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      name: Schema.String,
      reason: RoutingAccountReason,
      remainingPercent: Schema.NullOr(Schema.Number),
      quotaCheckedAt: Schema.NullOr(Schema.String),
      sharedWith: Schema.NullOr(ProviderInstanceId),
      /** The ladder the router would use: configured, or seeded for this provider. */
      ladder: Schema.optional(RoutingLadder),
      models: Schema.optional(
        Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String })),
      ),
    }),
  ),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      matchedTerms: Schema.Array(Schema.String),
    }),
  ),
  skillCatalogAvailable: Schema.Boolean,
});
export type RoutingPreview = typeof RoutingPreview.Type;

export const RoutingJudgmentInput = Schema.Struct({
  ...RoutingPreviewInput.fields,
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/)),
});
export type RoutingJudgmentInput = typeof RoutingJudgmentInput.Type;
export const JevConnectionInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("connect"),
    key: Schema.RedactedFromValue(Schema.String),
  }),
  Schema.Struct({ action: Schema.Literal("disconnect") }),
]);
export type JevConnectionInput = typeof JevConnectionInput.Type;
export const JevConnectionState = Schema.Struct({ configured: Schema.Boolean });
export type JevConnectionState = typeof JevConnectionState.Type;

export class RoutingJudgmentError extends Schema.TaggedError<RoutingJudgmentError>()(
  "RoutingJudgmentError",
  {
    reason: Schema.Literals([
      "not_configured",
      "invalid_input",
      "stale_preview",
      "price_unavailable",
      "budget_blocked",
      "already_requested",
      "request_uncertain",
      "invalid_response",
      "storage",
    ]),
  },
) {
  override get message() {
    return `Jev recommendation: ${this.reason}.`;
  }
}
