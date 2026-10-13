import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";
import { runDurationSeconds } from "./threadNotificationPolicy.ts";
import { threadNotificationText, type ThreadNotificationKind } from "./threadNotificationText.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
  /** Seconds the latest run took; only set on completed states that know both ends. */
  readonly runDurationSeconds?: number;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

export interface ProjectThreadAwarenessV2Input {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<Project, "title">;
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "id"
    | "lastError"
    | "latestRunCompletedAt"
    | "latestRunStartedAt"
    | "lineage"
    | "modelSelection"
    | "pendingBackgroundTasks"
    | "pendingRuntimeRequest"
    | "status"
    | "title"
    | "updatedAt"
  >;
  /**
   * The agent's latest reply, which shells do not carry. The caller reads it
   * only when it is about to notify; without it `detail` falls back to a
   * plain phrase.
   */
  readonly assistantText?: string | null;
  /**
   * The environment's Scratch project is a folder name, not a project the user
   * named, so notifications show the thread title in its place.
   */
  readonly projectIsScratch?: boolean;
}

/** Build relay activity directly from the V2 shell projection. */
export function projectThreadAwarenessV2(
  input: ProjectThreadAwarenessV2Input,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  const phase = resolveThreadAwarenessPhaseV2(thread);
  if (phase === null) {
    return null;
  }
  const noticeKind = notificationKindForPhase(phase);
  const detail =
    noticeKind === null
      ? undefined
      : threadNotificationText({
          kind: noticeKind,
          assistantText: input.assistantText,
          errorText: thread.lastError,
        }).excerpt;
  const durationSeconds =
    phase === "completed"
      ? runDurationSeconds(
          thread.latestRunStartedAt ? DateTime.formatIso(thread.latestRunStartedAt) : null,
          thread.latestRunCompletedAt ? DateTime.formatIso(thread.latestRunCompletedAt) : null,
        )
      : null;
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: input.projectIsScratch === true ? thread.title : project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: DateTime.formatIso(thread.updatedAt),
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
    ...(durationSeconds === null ? {} : { runDurationSeconds: durationSeconds }),
  };
}

function resolveThreadAwarenessPhaseV2(
  thread: ProjectThreadAwarenessV2Input["thread"],
): AgentAwarenessPhase | null {
  if (thread.pendingRuntimeRequest?.kind === "user_input") {
    return "waiting_for_input";
  }
  if (
    thread.pendingRuntimeRequest !== null &&
    thread.pendingRuntimeRequest.kind !== "auth_refresh"
  ) {
    return "waiting_for_approval";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "completed":
      // Work that will wake the agent keeps the run going; a dev server does not.
      return backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
        ? "running"
        : "completed";
    case "failed":
      return "failed";
    case "idle":
    case "queued":
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return null;
  }
}

function notificationKindForPhase(
  phase: AgentAwarenessPhase,
): Exclude<ThreadNotificationKind, "limited"> | null {
  switch (phase) {
    case "completed":
    case "failed":
    case "waiting_for_input":
    case "waiting_for_approval":
      return phase;
    case "starting":
    case "running":
    case "stale":
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
    case "waiting_for_input":
    case "completed":
    case "failed":
      // The short status label notifications show above the agent's own words.
      return threadNotificationText({ kind: phase }).label;
    case "stale":
      return "Update delayed";
  }
}
