import { Bell, Check, ArrowUpRight, Gauge, Monitor, RefreshCw, Server } from "lucide-react";
import { useNavigate, useParams, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  allowanceTone,
  collectLimitAccounts,
  cursorDisplayWindows,
  cursorWindowNote,
  formatResetPhrase,
  formatResetTitle,
  remainingPercent,
  sortAccountsByRemaining,
  sortWindowsByRemaining,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  meaningfulProjectTitle,
  type ThreadNotificationKind,
} from "@t3tools/shared/threadNotificationText";
import {
  useProjects,
  useServerConfigs,
  useThreadShell,
  useThreadShells,
} from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { getProviderInstanceEntry } from "../../providerInstances";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  notificationProjectKey,
  notificationProjectTitles,
  threadNotificationKind,
  threadNotificationSignature,
  threadShellNotificationText,
} from "../../threadNotificationCopy";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadUsagePopover } from "../chat/ThreadUsagePopover";
import { resolveContextWindowModelDisplayName } from "../chat/ContextWindowMeter.logic";
import { describeConversationEnvironment, describeConversationModel } from "./conversationIdentity";
import { useWorkbenchStore } from "./workbenchStore";
import { sessionKey, useWorkbenchPreferences, summarizePurpose } from "./workbenchPreferences";
import { currentProviderUsageLabel, currentProviderUsageTone, usageAlert } from "./workbenchUsage";
import { Cpu } from "lucide-react";

const NOTICE_TONES = {
  completed: "success",
  failed: "danger",
  limited: "danger",
  waiting_for_input: "info",
  waiting_for_approval: "warning",
} as const satisfies Record<ThreadNotificationKind, string>;

const toTitleCase = (label: string) => label.replace(/\b\w/g, (letter) => letter.toUpperCase());

export function WorkbenchNotifications() {
  const threads = useThreadShells();
  const dismissed = useWorkbenchPreferences((s) => s.dismissedAttention);
  const dismiss = useWorkbenchPreferences((s) => s.dismissAttention);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectTitles = notificationProjectTitles(
    projects,
    (environmentId) => serverConfigs.get(environmentId)?.scratchWorkspaceRoot,
  );
  const notices = threads
    .flatMap((thread) => {
      if (thread.archivedAt) return [];
      const status = resolveSidebarThreadStatus(thread);
      const kind = threadNotificationKind(
        status,
        status === "ready" && thread.latestRun?.status === "completed",
      );
      if (kind === null) return [];
      const text = threadShellNotificationText(thread, kind);
      const at = thread.latestRun?.completedAt ?? thread.latestRun?.startedAt ?? thread.updatedAt;
      const key = sessionKey(thread.environmentId, thread.id);
      const signature = threadNotificationSignature(thread, status);
      const project = meaningfulProjectTitle(
        projectTitles.get(notificationProjectKey(thread.environmentId, thread.projectId)),
        thread.title,
      );
      return [
        {
          thread,
          kind,
          label: toTitleCase(text.label),
          excerpt: text.isFallback ? null : text.excerpt,
          project,
          at,
          key,
          signature,
          unread: dismissed[key] !== signature,
        },
      ];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const unread = notices.filter((n) => n.unread);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Notifications${unread.length ? `, ${unread.length} Unread` : ""}`}
        data-wb-bell=""
      >
        <Bell size={17} />
        {unread.length > 0 && <span>{Math.min(unread.length, 99)}</span>}
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end">
        <div data-wb-notifications="">
          <header>
            <h2>Notifications</h2>
            <button
              disabled={!unread.length}
              onClick={() => unread.forEach((n) => dismiss(n.key, n.signature))}
            >
              Mark All Read
            </button>
          </header>
          {notices.length ? (
            notices.slice(0, 40).map((n) => (
              <div key={n.key} data-unread={n.unread}>
                <button
                  onClick={() => {
                    dismiss(n.key, n.signature);
                    setOpen(false);
                    useWorkbenchStore.getState().setMode("thread");
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId: n.thread.environmentId, threadId: n.thread.id },
                    });
                  }}
                >
                  <span data-wb-notice-heading="">
                    <strong data-tone={NOTICE_TONES[n.kind]}>{n.label}</strong>
                    <span>{n.thread.title}</span>
                  </span>
                  {n.excerpt && <em>{n.excerpt}</em>}
                  <small>
                    {n.project ? `${n.project} · ` : ""}
                    {formatRelativeTimeLabel(n.at)}
                  </small>
                </button>
                {n.unread && (
                  <button
                    aria-label={`Mark ${n.thread.title} Read`}
                    onClick={() => dismiss(n.key, n.signature)}
                  >
                    <Check size={16} />
                  </button>
                )}
              </div>
            ))
          ) : (
            <p>You’re all caught up. Completed tasks and sessions needing attention appear here.</p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function WorkbenchUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const accounts = sortAccountsByRemaining(collectLimitAccounts(presentations));
  const current = useThreadShell(resolveThreadRouteRef(useParams({ strict: false })));
  const currentProvider = current
    ? presentations
        .get(current.environmentId)
        ?.serverConfig?.providers.find(
          (p) =>
            p.instanceId ===
            (current.runtime?.providerInstanceId ?? current.modelSelection.instanceId),
        )
    : undefined;
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        [...presentations.keys()].map((environmentId) => refresh({ environmentId, input: {} })),
      );
      if (results.some((r) => r._tag === "Failure"))
        setError("Some accounts could not refresh. The last reported values remain visible.");
    } catch {
      setError("Could not refresh usage. Try again when the connection is available.");
    } finally {
      setBusy(false);
    }
  };
  const alert = usageAlert(accounts);
  const usageModel = current?.modelSelection?.model;
  const usageLabel = currentProviderUsageLabel(currentProvider, usageModel);
  const usageTone = currentProviderUsageTone(currentProvider, usageModel);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={alert ? `Subscription Usage, ${alert.message}` : "Subscription Usage"}
        data-wb-quota=""
        data-tone={usageTone ?? undefined}
        title={usageLabel}
      >
        <Gauge size={16} />
        <span>{usageLabel}</span>
        {alert ? <i aria-hidden data-wb-quota-dot={alert.level} /> : null}
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end">
        <div data-wb-usage="">
          <header>
            <h2>Subscription Usage</h2>
            <button
              aria-label="Refresh Subscription Usage"
              disabled={busy}
              onClick={() => void refreshAll()}
            >
              <RefreshCw size={15} />
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </header>
          <p>
            Provider-reported allowance. Session context is shown separately in your conversation.
          </p>
          {currentProvider && !currentProvider.usageLimits?.windows.length && (
            <p>
              {currentProvider.displayName || currentProvider.driver} has not reported an allowance.
              The accounts below have separate subscriptions.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {accounts.length ? (
            accounts.map((a) => (
              <section key={a.key}>
                <h3>
                  {a.displayName || a.driver}
                  {a.plan ? ` · ${a.plan}` : ""}
                </h3>
                {a.limits.windows.length ? (
                  sortWindowsByRemaining(
                    a.driver === "cursor"
                      ? cursorDisplayWindows(a.limits.windows)
                      : a.limits.windows,
                  ).map((w) => {
                    const remaining = Math.round(remainingPercent(w));
                    const tone = allowanceTone(w);
                    const exhausted = tone === "empty";
                    const note =
                      a.driver === "cursor" ? cursorWindowNote(w.id, exhausted) : undefined;
                    return (
                      <div key={w.id} data-wb-limit="" data-tone={tone}>
                        <span>{w.label}</span>
                        <strong>{exhausted ? "Used up" : `${remaining}% Left`}</strong>
                        <progress
                          aria-label={`${a.displayName || a.driver} ${w.label} ${exhausted ? "Used Up" : "Remaining"}`}
                          max={100}
                          value={remaining}
                        />
                        <small>
                          {note ? `${note} ` : null}
                          <Tooltip>
                            <TooltipTrigger render={<span tabIndex={0} />}>
                              {formatResetPhrase(w.resetsAt, Date.now())}
                            </TooltipTrigger>
                            {w.resetsAt ? (
                              <TooltipPopup side="bottom">
                                {formatResetTitle(w.resetsAt)}
                              </TooltipPopup>
                            ) : null}
                          </Tooltip>
                        </small>
                      </div>
                    );
                  })
                ) : (
                  <p>Allowance unavailable for this account.</p>
                )}
                <small>
                  Reported {new Date(a.limits.checkedAt).toLocaleString()}
                  {a.limits.unavailable ? " · Refresh Unavailable" : ""}
                </small>
              </section>
            ))
          ) : (
            <p>
              Your connected provider hasn’t reported subscription limits. Unknown usage is not
              treated as zero.
            </p>
          )}
          <Link to="/usage">
            Open Usage Details <ArrowUpRight size={14} />
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SessionPurposePreview({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const purpose = useWorkbenchPreferences((s) => s.purposes[sessionKey(environmentId, threadId)]);
  const originalRequest = useEnvironmentQuery(
    purpose
      ? null
      : orchestrationEnvironment.v2.threadPurpose({
          environmentId: EnvironmentId.make(environmentId),
          input: { threadId: ThreadId.make(threadId) },
        }),
  );
  const text = purpose ? summarizePurpose(purpose.text) : originalRequest.data?.text;
  return (
    <div data-wb-purpose="">
      <strong>Original Goal</strong>
      <p>
        {text ??
          (originalRequest.error
            ? "Couldn’t load the original request. Open this session to view its history."
            : !originalRequest.isSuccess
              ? "Loading the original request…"
              : "No original request is available in this session’s saved history.")}
      </p>
      {text && <small>From Your Original Request</small>}
    </div>
  );
}

const SESSION_CHIP_TEXT =
  "sr-only @[900px]/chat-header:not-sr-only @[900px]/chat-header:max-w-40 @[900px]/chat-header:truncate";

/**
 * Which machine a conversation lives on and which model is selected for it, or answered when the
 * provider reports a different one. Always visible so a reply can't quietly run on the wrong
 * machine or model.
 */
function ConversationIdentity({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const scopedEnvironmentId = EnvironmentId.make(environmentId);
  const shell = useThreadShell(scopeThreadRef(scopedEnvironmentId, ThreadId.make(threadId)));
  const environment = useEnvironment(scopedEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const providers = useServerConfigs().get(scopedEnvironmentId)?.providers;
  const where = describeConversationEnvironment({
    label: environment?.label ?? null,
    isPrimary: scopedEnvironmentId === primaryEnvironmentId,
    connected: connectedIds.includes(scopedEnvironmentId),
  });
  const selection = shell?.modelSelection;
  const entry =
    selection && providers ? getProviderInstanceEntry(providers, selection.instanceId) : undefined;
  const model = describeConversationModel({
    providerName: entry?.displayName ?? null,
    modelSlug: selection?.model ?? null,
    answeringModel: shell?.latestRun?.answeringModel ?? null,
    modelName: selection
      ? resolveContextWindowModelDisplayName(
          selection,
          new Map(entry ? [[selection.instanceId, entry.models]] : []),
        )
      : null,
  });
  return (
    <div data-wb-session-identity="">
      <Badge
        className="max-w-full"
        size="sm"
        title={where.title}
        variant={
          where.tone === "offline" ? "warning" : where.tone === "remote" ? "outline" : "secondary"
        }
      >
        {where.tone === "remote" ? <Server aria-hidden /> : <Monitor aria-hidden />}
        {/* Below ~900px the header shows icons only; the text stays for screen readers. */}
        <span className={SESSION_CHIP_TEXT}>{where.text}</span>
      </Badge>
      {shell && (
        <Badge
          className="max-w-full"
          size="sm"
          title={model.title}
          variant={model.mismatch ? "warning" : "secondary"}
        >
          <Cpu aria-hidden />
          <span className={SESSION_CHIP_TEXT}>{model.text}</span>
        </Badge>
      )}
    </div>
  );
}

/** The agent, machine and model chips that follow the title. Icons only when the header is narrow. */
export function WorkbenchSessionIdentity({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const key = sessionKey(environmentId, threadId);
  const agentId = useWorkbenchPreferences((s) => s.assignments[key]);
  const agent = useWorkbenchPreferences((s) => s.agents.find((a) => a.id === agentId));
  const started =
    useThreadShell(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId))) !==
    null;
  // A thread that has not started has no model to report, and the composer below already names
  // the machine it will run on.
  if (!started && !agent) return null;
  return (
    <div data-wb-session-bar="">
      {agent && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => {
                  useWorkbenchPreferences.getState().selectAgent(agent.id);
                  useWorkbenchStore.getState().setMode("agent");
                }}
              />
            }
          >
            <i data-wb-session-dot="" style={{ background: agent.color }} />
            <span className={SESSION_CHIP_TEXT}>{agent.name}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open {agent.name}</TooltipPopup>
        </Tooltip>
      )}
      <ConversationIdentity environmentId={environmentId} threadId={threadId} />
    </div>
  );
}

/** The context window button at the header's right edge, beside the panel buttons. */
export function WorkbenchSessionContext({
  environmentId,
  threadId,
  contextPercent,
}: {
  environmentId: string;
  threadId: string;
  contextPercent: number | null;
}) {
  if (contextPercent === null) return null;
  return (
    <div data-wb-session-bar="">
      <ThreadUsagePopover
        environmentId={environmentId}
        threadId={threadId}
        contextPercent={contextPercent}
      />
    </div>
  );
}
