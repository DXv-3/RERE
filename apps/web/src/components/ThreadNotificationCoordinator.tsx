import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  decideThreadNotification,
  minuteOfDay,
  parseClockMinutes,
  runDurationSeconds,
} from "@t3tools/shared/threadNotificationPolicy";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import {
  claimThreadNotification,
  notificationWindowFocused,
  trackNotificationWindowFocus,
} from "../threadNotificationOwnership";
import { chatGlobalInputOwner } from "../lib/chatInputOwnership";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  reportSystemNotificationError,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import {
  completionBatchDescription,
  completionBatchTitle,
  recordCompletion,
  type CompletionBatch,
} from "../threadNotificationBatch";
import {
  notificationBody,
  threadNotificationKind,
  threadNotificationSignature,
  threadShellNotificationText,
} from "../threadNotificationCopy";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";
import { sessionKey, useWorkbenchPreferences } from "./workbench/workbenchPreferences";

const BATCH_NOTIFICATION_TAG = "completions";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  useEffect(trackNotificationWindowFocus, []);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = useCallback((environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  }, []);
  // Threads finishing close together share one notification across all environments.
  const batch = useRef<CompletionBatch | null>(null);
  const addToBatch = useCallback((title: string) => {
    batch.current = recordCompletion(batch.current, Date.now(), title);
    return batch.current;
  }, []);
  const closeNotifications = useCallback((tags: ReadonlyArray<string>) => {
    for (const tag of tags) {
      pending.current.get(tag)?.notification.close();
      pending.current.delete(tag);
    }
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, notification }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
      closeNotifications={closeNotifications}
      addToBatch={addToBatch}
    />
  ));
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
  closeNotifications,
  addToBatch,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
  closeNotifications: (tags: ReadonlyArray<string>) => void;
  addToBatch: (title: string) => CompletionBatch;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const minRunSeconds = useClientSettings((settings) => settings.notifyMinRunSeconds);
  const quietHoursEnabled = useClientSettings((settings) => settings.notifyQuietHoursEnabled);
  const quietHoursStart = useClientSettings((settings) => settings.notifyQuietHoursStart);
  const quietHoursEnd = useClientSettings((settings) => settings.notifyQuietHoursEnd);
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previous = useRef(
    new Map<ThreadId, { attention: string | null; completion: number | null }>(),
  );

  useEffect(() => {
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, { attention: string | null; completion: number | null }>();
    for (const rawThread of shell.snapshot.value.threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const prior = previous.current.get(thread.id);
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? JSON.stringify([
              thread.latestRun?.runId ?? "",
              status,
              rawThread.pendingRuntimeRequest?.id ?? null,
            ])
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // Waiting only on commands (a dev server) is done; subagents and monitors wake the agent.
      const settled =
        status === "ready" ||
        (status === "waiting" && !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks));
      const completion =
        settled && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      const noticeKind = threadNotificationKind(status, kind === "completion");
      if (noticeKind === null) continue;
      const body = notificationBody(threadShellNotificationText(thread, noticeKind));
      const windowFocused = notificationWindowFocused();
      const viewedChat = windowFocused ? chatGlobalInputOwner() : null;
      const viewingThread =
        windowFocused &&
        viewedChat?.dataset.chatEnvironmentId === environmentId &&
        viewedChat.dataset.chatThreadId === thread.id;
      const quietStart = quietHoursEnabled ? parseClockMinutes(quietHoursStart) : null;
      const quietEnd = quietHoursEnabled ? parseClockMinutes(quietHoursEnd) : null;
      const decisionInput = {
        kind: noticeKind,
        runDurationSeconds: runDurationSeconds(
          thread.latestRun?.startedAt,
          thread.latestRun?.completedAt,
        ),
        minRunSeconds,
        quietHours:
          quietStart === null || quietEnd === null
            ? null
            : { startMinute: quietStart, endMinute: quietEnd },
        localMinuteOfDay: minuteOfDay(new Date()),
      } as const;
      const key = JSON.stringify([
        environmentId,
        thread.id,
        thread.latestRun?.runId ?? null,
        kind,
        kind === "completion" ? completion : attention,
      ]);
      const decision = decideThreadNotification({ ...decisionInput, viewingThread });
      if (!decision.notify) {
        // Consume a viewed event too, so another window cannot replay it after focus moves.
        if (viewingThread && (hasNotificationSound(mode) || hasDesktopNotifications(mode))) {
          void claimThreadNotification(key);
        }
        // The bell is a log: it still lists this, but a short reply the person watched arrives read.
        if (
          viewingThread &&
          noticeKind === "completed" &&
          decideThreadNotification(decisionInput).reason === "short_run"
        ) {
          useWorkbenchPreferences
            .getState()
            .dismissAttention(
              sessionKey(environmentId, thread.id),
              threadNotificationSignature(thread, status),
            );
        }
        continue;
      }
      const burst = kind === "completion" ? addToBatch(thread.title) : null;
      const batched = burst !== null && burst.count > 1;
      const deliverExternal = async () => {
        if (!hasNotificationSound(mode) && !hasDesktopNotifications(mode)) return;
        if (!(await claimThreadNotification(key)) || !mounted.current) return;
        // Claims/IPC can yield while the user focuses this chat or changes preferences.
        const owner = notificationWindowFocused() ? chatGlobalInputOwner() : null;
        if (
          owner?.dataset.chatEnvironmentId === environmentId &&
          owner.dataset.chatThreadId === thread.id
        )
          return;
        if (hasNotificationSound(getClientSettings().notificationMode) && !batched) {
          void playNotificationSound(kind, () => {
            const currentOwner = notificationWindowFocused() ? chatGlobalInputOwner() : null;
            return (
              mounted.current &&
              hasNotificationSound(getClientSettings().notificationMode) &&
              !(
                currentOwner?.dataset.chatEnvironmentId === environmentId &&
                currentOwner.dataset.chatThreadId === thread.id
              )
            );
          });
        }
        if (
          !hasDesktopNotifications(getClientSettings().notificationMode) ||
          notificationWindowFocused() ||
          typeof Notification === "undefined" ||
          Notification.permission !== "granted"
        )
          return;
        try {
          const tag = batched ? BATCH_NOTIFICATION_TAG : `${environmentId}:${thread.id}`;
          if (batched) closeNotifications(burst.osTags.filter((osTag) => osTag !== tag));
          const notification = new Notification(
            batched ? completionBatchTitle(burst.count) : thread.title,
            {
              body: batched ? completionBatchDescription(burst.titles) : body,
              tag,
              silent: true,
            },
          );
          if (burst !== null && !burst.osTags.includes(tag)) burst.osTags.push(tag);
          notification.addEventListener("error", reportSystemNotificationError, { once: true });
          onNotification(environmentId, notification);
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            if (batched) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          });
        } catch {
          reportSystemNotificationError();
        }
      };
      void deliverExternal();
      if (inAppNotificationsEnabled && windowFocused) {
        if (batched && burst.toastId !== null) {
          toastManager.update(burst.toastId, {
            title: completionBatchTitle(burst.count),
            description: completionBatchDescription(burst.titles),
            actionProps: undefined,
          });
          continue;
        }
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title: batched ? completionBatchTitle(burst.count) : thread.title,
          description: batched ? completionBatchDescription(burst.titles) : body,
          ...(burst === null
            ? {}
            : {
                onClose: () => {
                  if (burst.toastId === toastId) burst.toastId = null;
                },
              }),
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          ...(batched
            ? {}
            : {
                actionProps: {
                  children: "Open thread",
                  onClick: () => {
                    toastManager.close(toastId);
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: thread.id },
                    });
                  },
                },
              }),
        });
        if (burst !== null) burst.toastId = toastId;
        continue;
      }
    }
    previous.current = next;
  }, [
    addToBatch,
    closeNotifications,
    environmentId,
    inAppNotificationsEnabled,
    minRunSeconds,
    mode,
    navigate,
    onNotification,
    quietHoursEnabled,
    quietHoursEnd,
    quietHoursStart,
    shell,
  ]);

  return null;
}
