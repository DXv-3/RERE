import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { decideThreadNotification } from "@t3tools/shared/threadNotificationPolicy";
import { alertBodyForActivity } from "./agentActivityPayloads.ts";

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

export function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

type TransitionInput = {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
};

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

/** Which phase of a thread is a notification event, as the shared policy names it. */
const NOTIFICATION_KIND_BY_PHASE = {
  waiting_for_approval: "waiting_for_approval",
  waiting_for_input: "waiting_for_input",
  completed: "completed",
  failed: "failed",
} as const;

export function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
  runDurationSeconds?: number,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      if (!preferences.notifyOnApproval) return false;
      break;
    case "waiting_for_input":
      if (!preferences.notifyOnInput) return false;
      break;
    case "completed":
      if (!preferences.notifyOnCompletion) return false;
      break;
    case "failed":
      if (!preferences.notifyOnFailure) return false;
      break;
    default:
      return false;
  }
  return decideThreadNotification({
    kind: NOTIFICATION_KIND_BY_PHASE[phase],
    runDurationSeconds: runDurationSeconds ?? null,
    ...(preferences.minRunSeconds === undefined
      ? {}
      : { minRunSeconds: preferences.minRunSeconds }),
  }).notify;
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase, row.runDurationSeconds),
  );
}

// Reconciliation uses only observed transitions. Event-driven delivery can
// include fresh completions whose running update never reached the device.
export function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return (
      alertAllowedForPhase(input.preferences, row.phase, row.runDurationSeconds) &&
      isFreshTerminalNotification(row.updatedAt, input.nowMs)
    );
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: alertBodyForActivity(first) };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(input.preferences, row.phase, row.runDurationSeconds)
    ? alertForActivityRows([row])
    : null;
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly runDurationSeconds?: number | undefined;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase, input.runDurationSeconds) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}
