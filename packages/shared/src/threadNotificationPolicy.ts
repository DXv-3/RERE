/**
 * When a thread event should interrupt the person. One pure decision shared by
 * the web toast, OS alert and sound, and the phone push, so they agree. What a
 * notification says lives in `threadNotificationText`.
 */
import { DEFAULT_NOTIFY_MIN_RUN_SECONDS } from "@t3tools/contracts/settings";

import type { ThreadNotificationKind } from "./threadNotificationText.ts";

/** Kinds that need the person, so no setting silences them. */
const NEEDS_PERSON: ReadonlySet<ThreadNotificationKind> = new Set([
  "failed",
  "waiting_for_input",
  "waiting_for_approval",
  "limited",
]);

function notificationNeedsPerson(kind: ThreadNotificationKind): boolean {
  return NEEDS_PERSON.has(kind);
}

export interface NotificationQuietHours {
  /** Minutes after local midnight the quiet period starts (inclusive). */
  readonly startMinute: number;
  /** Minutes after local midnight the quiet period ends (exclusive). */
  readonly endMinute: number;
}

export type ThreadNotificationDecisionReason =
  | "subagent"
  | "viewing_thread"
  | "needs_person"
  | "quiet_hours"
  | "any_length"
  | "long_run"
  | "unknown_duration"
  | "short_run";

export interface ThreadNotificationDecisionInput {
  readonly kind: ThreadNotificationKind;
  /** Latest run start to completion in seconds; null when either end is unknown. */
  readonly runDurationSeconds: number | null;
  /** The window is focused and this thread is the one open. Only the web client knows. */
  readonly viewingThread?: boolean;
  readonly isSubagent?: boolean;
  readonly minRunSeconds?: number;
  /** Local time of day and the quiet period, both in the same (device) time zone. */
  readonly quietHours?: NotificationQuietHours | null;
  readonly localMinuteOfDay?: number | null;
}

export interface ThreadNotificationDecision {
  readonly notify: boolean;
  readonly reason: ThreadNotificationDecisionReason;
}

/** "HH:MM" to minutes after midnight, or null when it is not a 24-hour clock time. */
export function parseClockMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** A period that ends before it starts wraps past midnight; equal ends mean no period. */
export function isWithinQuietHours(minute: number, quietHours: NotificationQuietHours): boolean {
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/** Whole seconds a run took, or null when a time is missing, unreadable or out of order. */
export function runDurationSeconds(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): number | null {
  if (!startedAt || !completedAt) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return (completed - started) / 1_000;
}

export function decideThreadNotification(
  input: ThreadNotificationDecisionInput,
): ThreadNotificationDecision {
  if (input.isSubagent === true) return { notify: false, reason: "subagent" };
  if (input.viewingThread === true) return { notify: false, reason: "viewing_thread" };
  if (notificationNeedsPerson(input.kind)) return { notify: true, reason: "needs_person" };
  if (
    input.quietHours != null &&
    input.localMinuteOfDay != null &&
    isWithinQuietHours(input.localMinuteOfDay, input.quietHours)
  ) {
    return { notify: false, reason: "quiet_hours" };
  }
  const minRunSeconds = input.minRunSeconds ?? DEFAULT_NOTIFY_MIN_RUN_SECONDS;
  if (minRunSeconds <= 0) return { notify: true, reason: "any_length" };
  if (input.runDurationSeconds === null) return { notify: true, reason: "unknown_duration" };
  return input.runDurationSeconds >= minRunSeconds
    ? { notify: true, reason: "long_run" }
    : { notify: false, reason: "short_run" };
}
