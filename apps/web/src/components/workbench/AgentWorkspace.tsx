import { openVoiceConversation } from "../../voice/voiceActions";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ModelSelection,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { AgentRecoveryPanel } from "./AgentRecoveryPanel";
import { CampaignsView } from "../campaigns/CampaignsView";
import { SchedulesView } from "./SchedulesView";
import { AgentCheckInInbox } from "./AgentCheckInInbox";
import { AgentGoalsPanel } from "./AgentGoalsPanel";
import { AgentSecretsPanel } from "./AgentSecretsPanel";
import { AgentTeamBoard } from "./AgentTeamBoard";
import { buildAgentBoard } from "./agentBoard";
import { countPendingByAgent } from "@t3tools/client-runtime/operations/agent-check-ins";
import { usePendingCheckIns } from "./useAgentCheckIns";
import { AgentMovePanel } from "./AgentMovePanel";
import { AgentSyncPanel } from "./AgentSyncPanel";
import { useAgentSyncStatus, useAgentSyncTarget } from "./useAgentSync";
import { agentKickoffMessage } from "@t3tools/client-runtime/operations/agent-kickoff";
import { selectOldTransferCopies } from "@t3tools/client-runtime/operations/agent-conversation-sync";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadActions } from "../../hooks/useThreadActions";
import { AGENTS_CHANGED_EVENT } from "./useAgentWorkspace";
import {
  NEW_AGENT_CONVERSATION_EVENT,
  resolveRememberedConversation,
  type NewAgentConversationRequest,
} from "./agentConversationTabs.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AgentAvatar, AgentAvatarEditor } from "./AgentAvatar";
import { TOOL_ACCESS_OPTIONS, withToolGroup } from "./agentToolAccess";
import { Switch } from "../ui/switch";
import { useAgentWorkspace } from "./useAgentWorkspace";
import { useNowMinute } from "../../hooks/useNowMinute";
import { GrokBotMigration, GrokBotHistory } from "./GrokBotMigration";
import { randomUUID } from "../../lib/utils";
import { useState, useEffect, useMemo, useRef, useEffectEvent } from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  Plus,
  Settings2,
  MessageSquare,
  Pin,
  ArrowRight,
  Trash2,
  LayoutGrid,
  Inbox,
  Megaphone,
  CalendarClock,
  Phone,
} from "lucide-react";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";

import { useWorkbenchStore } from "./workbenchStore";
import {
  AGENT_COLORS,
  projectKey,
  sessionKey,
  summarizePurpose,
  useWorkbenchPreferences,
  type AgentProfile,
} from "./workbenchPreferences";

export function AgentWorkspace({ railOnly = false }: { railOnly?: boolean }) {
  const {
    agents: localAgents,
    selectedAgentId,
    agentEnvironmentId,
    selectAgentEnvironment,
    assignments,
    selectAgent,
    assign,
    storageError,
  } = useWorkbenchPreferences();
  // The tab works against one environment at a time; the stored choice defaults to primary.
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const serverConfigs = useServerConfigs();
  // A stored choice for an environment that has since been removed falls back to primary.
  const environmentId = (
    environments.some((e) => e.environmentId === agentEnvironmentId)
      ? agentEnvironmentId
      : primaryEnvironmentId
  ) as EnvironmentId | null;
  const workspace = useAgentWorkspace(environmentId);
  // Moving is the manual path; with sync on, both environments already hold every agent.
  const syncTargetId = useAgentSyncTarget();
  const syncStatus = useAgentSyncStatus();
  const syncedAt = syncStatus.syncedAt;
  const refreshWorkspace = useEffectEvent(() => void workspace.refresh());
  useEffect(() => {
    if (syncedAt !== null) refreshWorkspace();
  }, [syncedAt]);
  // A filed or reviewed check-in can pause or finish a goal, which changes the agent's revision.
  const pendingCheckIns = usePendingCheckIns(workspace.environmentId, workspace.connected);
  const checkInsUpdatedAt = pendingCheckIns.updatedAt;
  useEffect(() => {
    if (checkInsUpdatedAt > 0) refreshWorkspace();
  }, [checkInsUpdatedAt]);
  const pendingByAgent = useMemo(
    () => countPendingByAgent(pendingCheckIns.checkIns),
    [pendingCheckIns.checkIns],
  );
  const environmentOptions = environments.filter(
    (e) =>
      e.environmentId === environmentId ||
      (connectedIds.includes(e.environmentId) && serverConfigs.has(e.environmentId)),
  );
  const saveAgent = (agent: AgentProfile) => {
    void workspace.saveProfile(agent).catch((e) => setError(e.message));
  };
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const { archiveThread } = useThreadActions();
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const persistThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const config = environmentId ? serverConfigs.get(environmentId) : undefined;
  const providerEntries = deriveProviderInstanceEntries(config?.providers ?? []);
  const setAgentView = useWorkbenchStore((s) => s.setAgentView);
  const agentView = useWorkbenchStore((s) => s.agentView);
  const setMode = useWorkbenchStore((s) => s.setMode);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Browser-local agents belong to the primary environment only.
  const agents = workspace.ready
    ? workspace.entries.filter((a) => !a.archivedAt).map((a) => a.profile)
    : workspace.isPrimary
      ? localAgents
      : [];
  const selectedRecord =
    workspace.entries.find((a) => !a.archivedAt && a.profile.id === selectedAgentId) ??
    workspace.entries.find((a) => !a.archivedAt);
  const selected = agents.find((a) => a.id === selectedAgentId) ?? agents[0];
  const conversations = threads.filter(
    (t) =>
      !t.archivedAt &&
      t.environmentId === workspace.environmentId &&
      (assignments[sessionKey(t.environmentId, t.id)] === selected?.id ||
        selectedRecord?.threadIds?.includes(t.id)),
  );
  // Minute clock so a run going quiet shows without waiting for another event.
  const nowMinute = useNowMinute();
  const boardEntries = useMemo(
    () =>
      workspace.ready && workspace.environmentId
        ? buildAgentBoard({
            agents: workspace.entries
              .filter((a) => !a.archivedAt)
              .map((a) => ({
                id: a.profile.id,
                name: a.profile.name,
                primaryThreadId: a.primaryThreadId,
                threadIds: a.threadIds,
                profile: a.profile,
              })),
            threads,
            workspaceEnvironmentId: workspace.environmentId,
            // Sync off means every agent's conversation is its primary thread here.
            live: syncTargetId !== null ? syncStatus.live : {},
            localEnvironmentId: primaryEnvironmentId,
            pendingCheckIns: pendingByAgent,
            nowMs: Date.parse(`${nowMinute}:00Z`),
          })
        : [],
    [
      workspace.ready,
      workspace.environmentId,
      workspace.entries,
      threads,
      syncTargetId,
      syncStatus.live,
      primaryEnvironmentId,
      pendingByAgent,
      nowMinute,
    ],
  );
  const primaryConversation = conversations.find((t) => t.id === selectedRecord?.primaryThreadId);
  // Leftover copies from earlier transfers. With sync on, nothing is offered until the live and
  // copy pair is known, so the current copy is never mistaken for a leftover.
  const copyPair =
    selected &&
    (syncStatus.pairing?.local === workspace.environmentId ||
      syncStatus.pairing?.remote === workspace.environmentId)
      ? (syncStatus.pairing?.copies[selected.id] ?? null)
      : null;
  const oldCopyIds =
    selected && workspace.environmentId && !(syncTargetId !== null && syncStatus.pairing === null)
      ? selectOldTransferCopies({
          threadIds: conversations.map((t) => t.id),
          primaryThreadId: selectedRecord?.primaryThreadId,
          pair: copyPair,
        })
      : [];
  const archiveOldCopies = async () => {
    const targetEnvironmentId = workspace.environmentId;
    if (!targetEnvironmentId || oldCopyIds.length === 0) return;
    const count = oldCopyIds.length;
    if (
      !window.confirm(
        `Archive ${count} old ${count === 1 ? "copy" : "copies"}? They can be restored from Archived Threads.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    let failed = 0;
    for (const id of oldCopyIds) {
      const result = await archiveThread(scopeThreadRef(targetEnvironmentId, ThreadId.make(id)));
      if (result._tag === "Failure") failed += 1;
    }
    setBusy(false);
    if (failed > 0) {
      setError(
        `${failed} of ${count} old ${count === 1 ? "copy" : "copies"} could not be archived. A copy that is still running cannot be archived yet.`,
      );
    }
  };
  const newAgent = () => {
    setAgentView("details");
    setEditing({
      id: randomUUID(),
      name: "",
      description: "",
      instructions: "",
      color: AGENT_COLORS[agents.length % AGENT_COLORS.length]!,
      pinned: true,
      projectKey: "",
      // A new agent is meant to get on with its work unattended. Supervised is one choice away.
      runtimeMode: "full-access",
      modelSelection: null,
    });
  };
  // `created` is the record of an agent saved a moment ago, before it shows up in the list. Such
  // an agent is also given its first turn, so it starts working without being spoken to.
  const start = async (agent: AgentProfile, separate = false, created?: WorkspaceAgent) => {
    if (!workspace.environmentId || !workspace.ready) {
      setError("Connect to your agent workspace first.");
      return;
    }
    if (!separate) opened.current = agent.id;
    const record = created ?? workspace.entries.find((a) => a.profile.id === agent.id);
    if (!record) return;
    // With sync on, an agent's conversation continues wherever it was last replied to.
    const live = syncTargetId !== null ? syncStatus.live[agent.id] : undefined;
    if (!separate && live) {
      assign(sessionKey(live.environmentId, live.threadId), agent.id);
      setAgentView("conversation");
      setMode("agent");
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: live.environmentId,
          threadId: ThreadId.make(live.threadId),
        }),
      });
      return;
    }
    if (!separate && record.primaryThreadId) {
      // Reopen the conversation this agent was last showing, if it still has a tab.
      const reopenId =
        resolveRememberedConversation({
          remembered:
            useWorkbenchPreferences.getState().lastConversations[
              sessionKey(workspace.environmentId, agent.id)
            ],
          tabIds: [
            record.primaryThreadId,
            ...(record.threadIds ?? []).filter((id) =>
              threads.some(
                (t) => t.id === id && t.environmentId === workspace.environmentId && !t.archivedAt,
              ),
            ),
          ],
          primaryThreadId: record.primaryThreadId,
        }) ?? record.primaryThreadId;
      assign(sessionKey(workspace.environmentId, reopenId), agent.id);
      setAgentView("conversation");
      setMode("agent");
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: workspace.environmentId,
          threadId: ThreadId.make(reopenId),
        }),
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let projectId = projects.find(
        (p) =>
          p.environmentId === workspace.environmentId &&
          projectKey(p.environmentId, p.id) === agent.projectKey,
      )?.id;
      if (!projectId) {
        if (agent.projectKey)
          throw new Error(
            "This agent’s selected project is unavailable. Choose another project or Personal Workspace.",
          );
        const scratch = await ensureScratch({ environmentId: workspace.environmentId, input: {} });
        if (scratch._tag === "Failure") throw new Error("Could not prepare a personal workspace.");
        projectId = scratch.value.projectId;
      }
      const defaultProvider = providerEntries.find((entry) => entry.enabled && entry.isAvailable);
      const defaultModel =
        defaultProvider?.models.find((model) => model.isDefault)?.slug ??
        defaultProvider?.models[0]?.slug;
      const chosen =
        agent.modelSelection ??
        config?.settings.defaultModelSelection ??
        (defaultProvider && defaultModel
          ? { instanceId: defaultProvider.instanceId, model: defaultModel }
          : null);
      if (!chosen) {
        setEditing(agent);
        throw new Error("Choose a model for this agent.");
      }
      const threadId = ThreadId.make(separate ? randomUUID() : `agent:${agent.id}`);
      const result = await persistThread({
        environmentId: workspace.environmentId,
        input: {
          ...(!separate ? { commandId: CommandId.make(`agent-primary-create:${agent.id}`) } : {}),
          threadId,
          projectId,
          title: agent.name,
          modelSelection: chosen,
          runtimeMode: agent.runtimeMode === "inherit" ? "approval-required" : agent.runtimeMode,
          prepareAgentWorkspace: true,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (result._tag === "Failure")
        throw new Error("Could not open the conversation. No task was submitted.");
      await workspace.save({
        ...record,
        primaryThreadId: record.primaryThreadId ?? threadId,
        threadIds: [...(record.threadIds ?? []), threadId],
      });
      assign(sessionKey(workspace.environmentId, threadId), agent.id);
      setAgentView("conversation");
      setMode("agent");
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: workspace.environmentId, threadId }),
      });
      const kickoff = created && !separate ? agentKickoffMessage(agent) : null;
      if (kickoff) {
        const started = await startTurn({
          environmentId: workspace.environmentId,
          input: {
            threadId,
            message: {
              messageId: MessageId.make(`agent-kickoff:${agent.id}`),
              role: "user",
              text: kickoff,
              attachments: [],
            },
            modelSelection: chosen,
            runtimeMode: agent.runtimeMode === "inherit" ? "approval-required" : agent.runtimeMode,
            interactionMode: "default",
          },
        });
        if (started._tag === "Failure")
          throw new Error("The agent was created but could not be started. Send it a message.");
      }
    } catch (e) {
      opened.current = null;
      setAgentView("details");
      setError(e instanceof Error ? e.message : "Could not open conversation.");
    } finally {
      setBusy(false);
    }
  };

  // A remembered conversation whose agent has since been deleted opens the board instead of
  // another agent's chat.
  useEffect(() => {
    if (
      workspace.ready &&
      agentView === "conversation" &&
      selectedAgentId !== null &&
      !agents.some((a) => a.id === selectedAgentId)
    )
      setAgentView("board");
  }, [workspace.ready, agentView, selectedAgentId, agents, setAgentView]);

  // The tab strip above a conversation asks for a new chat here, so thread creation stays in `start`.
  // A conversation can be open on a different machine from the one this tab last worked in; the
  // request then switches the tab to that machine and runs once its agents have loaded.
  const pendingConversation = useRef<NewAgentConversationRequest | null>(null);
  const startRequestedConversation = (request: NewAgentConversationRequest) => {
    const agent = agents.find((a) => a.id === request.agentId);
    if (!agent) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not start a new conversation",
          description: "This agent was not found on that machine. Refresh and try again.",
        }),
      );
      request.done();
      return;
    }
    void start(agent, true).finally(request.done);
  };
  const newConversationFromEvent = useEffectEvent((event: Event) => {
    const request = (event as CustomEvent<NewAgentConversationRequest>).detail;
    if (busy || pendingConversation.current !== null) {
      request.done();
      return;
    }
    if (request.environmentId !== workspace.environmentId) {
      if (!connectedIds.some((id) => id === request.environmentId)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start a new conversation",
            description: "That machine is not connected right now.",
          }),
        );
        request.done();
        return;
      }
      pendingConversation.current = request;
      selectAgentEnvironment(request.environmentId);
      return;
    }
    startRequestedConversation(request);
  });
  const runPendingConversation = useEffectEvent(() => {
    const request = pendingConversation.current;
    if (!request || !workspace.ready || workspace.environmentId !== request.environmentId) return;
    pendingConversation.current = null;
    startRequestedConversation(request);
  });
  useEffect(() => {
    runPendingConversation();
  }, [workspace.ready, workspace.environmentId]);
  useEffect(() => {
    const onRequest = (event: Event) => newConversationFromEvent(event);
    window.addEventListener(NEW_AGENT_CONVERSATION_EVENT, onRequest);
    return () => window.removeEventListener(NEW_AGENT_CONVERSATION_EVENT, onRequest);
  }, []);

  const opened = useRef<string | null>(null);
  const openFromEffect = useEffectEvent(() => {
    if (selected) void start(selected);
  });
  useEffect(() => {
    if (!railOnly || !workspace.ready || !selected) return;
    if (opened.current === selected.id) return;
    openFromEffect();
  }, [railOnly, workspace.ready, selected]);

  return (
    <section
      data-wb-agents=""
      data-wb-agent-rail-only={railOnly ? "true" : undefined}
      aria-label="Agent Workspace"
    >
      <aside data-wb-agent-rail="">
        <div data-wb-agent-heading="">
          <h1>Your Agents</h1>
          {railOnly && (
            <button aria-label="Agent Details" onClick={() => setAgentView("details")}>
              <Settings2 size={18} />
            </button>
          )}
          <button aria-label="Create Agent" onClick={newAgent}>
            <Plus size={18} />
          </button>
        </div>
        <button
          data-wb-board-toggle=""
          aria-pressed={agentView === "board"}
          onClick={() => {
            setEditing(null);
            setError(null);
            setAgentView("board");
          }}
        >
          <LayoutGrid size={15} />
          Team Board
        </button>
        <button
          data-wb-board-toggle=""
          aria-pressed={agentView === "checkins"}
          onClick={() => {
            setEditing(null);
            setError(null);
            setAgentView("checkins");
          }}
        >
          <Inbox size={15} />
          Check-Ins
          {pendingCheckIns.checkIns.length > 0 && (
            <span data-wb-count="">
              {pendingCheckIns.checkIns.length}
              {pendingCheckIns.hasMore && "+"}
              <span className="sr-only"> Waiting</span>
            </span>
          )}
        </button>
        <button
          data-wb-board-toggle=""
          aria-pressed={agentView === "campaigns"}
          onClick={() => {
            setEditing(null);
            setError(null);
            setAgentView("campaigns");
          }}
        >
          <Megaphone size={15} />
          Campaigns
        </button>
        <button
          data-wb-board-toggle=""
          aria-pressed={agentView === "schedules"}
          onClick={() => {
            setEditing(null);
            setError(null);
            setAgentView("schedules");
          }}
        >
          <CalendarClock size={15} />
          Schedules
        </button>
        <div data-wb-pinned-agents="">
          {agents
            .filter((a) => a.pinned)
            .map((a) => (
              <button
                key={a.id}
                disabled={busy}
                aria-pressed={a.id === selected?.id}
                onClick={() => {
                  selectAgent(a.id);
                  setEditing(null);
                  setError(null);
                  setAgentView("conversation");
                }}
              >
                <AgentAvatar agent={a} />
                <span>{a.name}</span>
              </button>
            ))}
        </div>
        {!railOnly && environmentOptions.length > 1 && (
          <label data-wb-agent-environment="">
            Environment
            <select
              value={environmentId ?? ""}
              disabled={busy}
              onChange={(e) => {
                selectAgentEnvironment(e.target.value);
                setEditing(null);
                setError(null);
              }}
            >
              {environmentOptions.map((e) => (
                <option key={e.environmentId} value={e.environmentId}>
                  {e.label}
                  {e.environmentId === primaryEnvironmentId ? " (This Device)" : ""}
                  {connectedIds.includes(e.environmentId) ? "" : " (Offline)"}
                </option>
              ))}
            </select>
          </label>
        )}
        <p data-wb-eyebrow="">All Agents</p>
        {agents.map((a) => (
          <button
            key={a.id}
            disabled={busy}
            data-wb-agent-row=""
            aria-pressed={a.id === selected?.id}
            onClick={() => {
              selectAgent(a.id);
              setEditing(null);
              setError(null);
              setAgentView("conversation");
            }}
          >
            <AgentAvatar agent={a} />
            <span>
              <strong>{a.name}</strong>
              <small>{a.description || "Ready For Your Next Task"}</small>
            </span>
          </button>
        ))}
        {!agents.length && (
          <p>Create an agent with reusable instructions and a personal workspace.</p>
        )}
        <GrokBotMigration importToServer={workspace.importAgents} />
        {workspace.error && <p role="alert">{workspace.error}</p>}
        {workspace.ready &&
          workspace.isPrimary &&
          localAgents.some((a) => !workspace.entries.some((e) => e.profile.id === a.id)) && (
            <button onClick={() => void workspace.migrateLocal().catch((e) => setError(e.message))}>
              Bring Existing Agents Into This Workspace
            </button>
          )}
        {workspace.entries.some((a) => a.archivedAt) && (
          <details>
            <summary>Archived Agents</summary>
            {workspace.entries
              .filter((a) => a.archivedAt)
              .map((a) => (
                <button
                  key={a.profile.id}
                  onClick={() =>
                    void workspace
                      .save({ ...a, archivedAt: null })
                      .catch((e) => setError(e.message))
                  }
                >
                  Restore {a.profile.name}
                </button>
              ))}
          </details>
        )}
        <small data-wb-agent-local="">Profiles And History In Your Workspace</small>
      </aside>
      <div data-wb-agent-detail="" hidden={railOnly}>
        {(error || storageError) && (
          <p role="alert" data-wb-error="">
            {error || storageError}
          </p>
        )}
        {editing ? (
          <form
            data-wb-agent-form=""
            onSubmit={async (e) => {
              e.preventDefault();
              if (!editing.name.trim()) return;
              try {
                const isNew = !agents.some((a) => a.id === editing.id);
                const saved = await workspace.saveProfile(editing);
                setEditing(null);
                if (isNew && agentKickoffMessage(editing)) await start(editing, false, saved);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save agent.");
              }
            }}
          >
            <h2>
              {agents.some((a) => a.id === editing.id) ? "Agent Settings" : "Create An Agent"}
            </h2>
            <label>
              Name
              <input
                required
                maxLength={80}
                autoFocus
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label>
              Purpose
              <input
                maxLength={240}
                placeholder="What this agent helps you do"
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <label>
              Instructions
              <textarea
                rows={7}
                maxLength={16000}
                placeholder="Role, goals, working style, and any rules this agent should follow."
                value={editing.instructions}
                onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
              />
            </label>
            <label>
              Project
              <select
                value={editing.projectKey}
                onChange={(e) =>
                  setEditing({ ...editing, projectKey: e.target.value, modelSelection: null })
                }
              >
                <option value="">Personal Workspace</option>
                {projects
                  .filter((p) => p.environmentId === workspace.environmentId)
                  .map((p) => (
                    <option
                      key={projectKey(p.environmentId, p.id)}
                      value={projectKey(p.environmentId, p.id)}
                    >
                      {p.title} · {p.workspaceRoot}
                    </option>
                  ))}
              </select>
            </label>
            {!projects.length && (
              <p>
                Your personal workspace is prepared automatically. You can attach a code project
                later.
              </p>
            )}
            <label>
              Permissions
              <select
                value={editing.runtimeMode}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    runtimeMode: e.target.value as AgentProfile["runtimeMode"],
                  })
                }
              >
                <option value="inherit">Use Project Defaults</option>
                <option value="approval-required">Ask For Approval</option>
                <option value="auto-accept-edits">Accept File Edits</option>
                <option value="auto">Auto</option>
                <option value="full-access">Full Access</option>
              </select>
            </label>
            <label>
              Model
              <select
                value={
                  editing.modelSelection
                    ? JSON.stringify([
                        editing.modelSelection.instanceId,
                        editing.modelSelection.model,
                      ])
                    : ""
                }
                onChange={(e) => {
                  if (!e.target.value) {
                    setEditing({ ...editing, modelSelection: null });
                    return;
                  }
                  const [instanceId, model] = JSON.parse(e.target.value) as [
                    ModelSelection["instanceId"],
                    string,
                  ];
                  setEditing({ ...editing, modelSelection: { instanceId, model } });
                }}
              >
                <option value="">Workspace Default</option>
                {providerEntries.map((p) => (
                  <optgroup key={p.instanceId} label={p.displayName}>
                    {p.models.map((m) => (
                      <option
                        key={m.slug}
                        disabled={!p.enabled || p.status !== "ready"}
                        value={JSON.stringify([p.instanceId, m.slug])}
                      >
                        {m.name ?? m.slug}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <AgentAvatarEditor
              agent={editing}
              onChange={(avatar) => setEditing({ ...editing, avatar, color: avatar.color })}
            />
            <fieldset>
              <legend>Quick Colors</legend>
              <div data-wb-color-options="">
                {AGENT_COLORS.map((color, i) => (
                  <button
                    type="button"
                    key={color}
                    style={{ background: color }}
                    aria-label={`Agent Color ${i + 1}`}
                    aria-pressed={color === editing.color}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        color,
                        ...(editing.avatar ? { avatar: { ...editing.avatar, color } } : {}),
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>
            <fieldset data-wb-tool-access="">
              <legend>Tool Access</legend>
              <small>
                Switch off groups of built-in tools for this agent. A change applies to its next
                tool call.
              </small>
              {TOOL_ACCESS_OPTIONS.map(({ group, label, description }) => (
                <div key={group} data-wb-tool-switch="">
                  <span>
                    <strong id={`wb-tool-${group}-label`}>{label}</strong>
                    <small id={`wb-tool-${group}-description`}>{description}</small>
                  </span>
                  <Switch
                    aria-labelledby={`wb-tool-${group}-label`}
                    aria-describedby={`wb-tool-${group}-description`}
                    checked={!editing.blockedToolGroups?.includes(group)}
                    onCheckedChange={(on) =>
                      setEditing({
                        ...editing,
                        blockedToolGroups: withToolGroup(editing.blockedToolGroups, group, on),
                      })
                    }
                  />
                </div>
              ))}
            </fieldset>
            <label data-wb-checkbox="">
              <input
                type="checkbox"
                checked={editing.pinned}
                onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })}
              />
              Pin This Agent
            </label>
            <div data-wb-actions="">
              <button type="submit" data-wb-primary="">
                Save Agent
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : agentView === "checkins" ? (
          <AgentCheckInInbox
            environmentId={workspace.environmentId}
            connected={workspace.connected}
            agents={workspace.entries}
            onOpen={(agent) => {
              selectAgent(agent.id);
              setEditing(null);
              setError(null);
              void start(agent);
            }}
          />
        ) : agentView === "campaigns" ? (
          <CampaignsView environmentId={workspace.environmentId} connected={workspace.connected} />
        ) : agentView === "schedules" ? (
          <SchedulesView
            environmentId={workspace.environmentId}
            connected={workspace.connected}
            agents={workspace.entries}
            onAgentChange={workspace.applyAgent}
            onOpenAgent={(agent) => {
              selectAgent(agent.profile.id);
              setEditing(null);
              setError(null);
              void start(agent.profile);
            }}
          />
        ) : agentView === "board" && selected ? (
          <AgentTeamBoard
            entries={boardEntries}
            ready={workspace.ready}
            busy={busy}
            environmentLabel={(id) => environments.find((e) => e.environmentId === id)?.label ?? id}
            onOpen={(agent) => {
              // Same as a tile: choose the agent, then open it the way the tile's effect would.
              selectAgent(agent.id);
              setEditing(null);
              setError(null);
              void start(agent);
            }}
          />
        ) : selected ? (
          <>
            <header data-wb-agent-title="">
              <AgentAvatar agent={selected} size={64} />
              <div>
                <h2>{selected.name}</h2>
                <p>{selected.description}</p>
              </div>
              <button aria-label="Agent Settings" onClick={() => setEditing(selected)}>
                <Settings2 size={18} />
              </button>
              <button
                aria-label={selected.pinned ? "Unpin Agent" : "Pin Agent"}
                aria-pressed={selected.pinned}
                onClick={() => saveAgent({ ...selected, pinned: !selected.pinned })}
              >
                <Pin size={17} />
              </button>
            </header>
            <div data-wb-actions="">
              <button data-wb-primary="" disabled={busy} onClick={() => void start(selected)}>
                <Plus size={16} />
                {busy
                  ? "Opening…"
                  : selectedRecord?.primaryThreadId
                    ? "Continue Conversation"
                    : "Open Conversation"}
              </button>
              {selectedRecord?.primaryThreadId && workspace.environmentId && (
                <button
                  onClick={() =>
                    openVoiceConversation({
                      environmentId: workspace.environmentId!,
                      threadId: ThreadId.make(selectedRecord.primaryThreadId!),
                      name: selected.name,
                    })
                  }
                >
                  <Phone size={16} />
                  Talk To Agent
                </button>
              )}
              <button onClick={() => setMode("thread")}>
                <ArrowRight size={16} />
                Return To Workspace
              </button>
            </div>
            {primaryConversation && (
              <section aria-label="Current Workbench Activity">
                <h3>Current Workbench Activity</h3>
                <p>
                  {primaryConversation.hasPendingApprovals
                    ? "Waiting For Approval"
                    : primaryConversation.hasPendingUserInput
                      ? "Waiting For Your Reply"
                      : primaryConversation.source.status.replaceAll("_", " ")}
                </p>
                <p>Last activity {new Date(primaryConversation.updatedAt).toLocaleString()}</p>
                {primaryConversation.source.lastError && (
                  <p role="alert">{primaryConversation.source.lastError}</p>
                )}
              </section>
            )}
            {selectedRecord && (
              <AgentRecoveryPanel
                key={`recovery:${selectedRecord.profile.id}`}
                agent={selectedRecord}
                save={workspace.save}
                prepare={workspace.prepare}
                providers={providerEntries}
              />
            )}
            {selectedRecord && workspace.environmentId && (
              <AgentGoalsPanel
                key={`goals:${workspace.environmentId}:${selectedRecord.profile.id}`}
                environmentId={workspace.environmentId}
                agent={selectedRecord}
                connected={workspace.connected}
                onAgentChange={workspace.applyAgent}
                onReviewCheckIns={() => setAgentView("checkins")}
              />
            )}
            {selectedRecord && workspace.environmentId && (
              <AgentSecretsPanel
                key={`secrets:${workspace.environmentId}:${selectedRecord.profile.id}`}
                environmentId={workspace.environmentId}
                agent={selectedRecord}
                connected={workspace.connected}
              />
            )}
            <h3>Task Conversations</h3>
            <button disabled={busy} onClick={() => void start(selected, true)}>
              New Task Conversation
            </button>
            {conversations.length ? (
              conversations.map((t) => (
                <button
                  data-wb-conversation=""
                  key={sessionKey(t.environmentId, t.id)}
                  onClick={() => {
                    setAgentView("conversation");
                    setMode("agent");
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams({
                        environmentId: t.environmentId,
                        threadId: t.id,
                      }),
                    });
                  }}
                >
                  <MessageSquare size={18} />
                  <span>
                    <strong>{t.title}</strong>
                    <small>
                      {summarizePurpose(
                        t.source.latestVisibleMessage?.text || "Open Conversation",
                        160,
                      )}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))
            ) : (
              <p>
                Your ongoing conversation starts here. Imported messages are shown below; opening a
                conversation does not start a task.
              </p>
            )}
            {oldCopyIds.length > 0 && (
              <button disabled={busy} onClick={() => void archiveOldCopies()}>
                Archive Old Copies ({oldCopyIds.length})
              </button>
            )}
            <GrokBotHistory
              key={`archive:${selected.id}`}
              agentId={selected.id}
              serverArchive={selectedRecord?.archive ?? undefined}
              initiallyExpanded
            />
            <details data-wb-agent-instructions="">
              <summary>Saved Instructions</summary>
              <p>{selected.instructions || "No custom instructions yet."}</p>
            </details>
            <AgentSyncPanel />
            {environmentId && syncTargetId === null && (
              <AgentMovePanel
                key={`move:${environmentId}`}
                sourceEnvironmentId={environmentId}
                selectedAgentId={selected.id}
                onMoved={() => {
                  void workspace.refresh();
                  window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
                }}
              />
            )}
            <button
              data-wb-remove=""
              onClick={() => {
                if (
                  window.confirm(
                    `Archive ${selected.name}? Its history and settings are preserved and can be restored.`,
                  )
                )
                  if (selectedRecord)
                    void workspace
                      .save({ ...selectedRecord, archivedAt: new Date().toISOString() })
                      .catch((e) => setError(e.message));
              }}
            >
              <Trash2 size={14} />
              Archive Agent
            </button>
          </>
        ) : (
          <div data-wb-agent-empty="">
            <span data-wb-eyebrow="">A Team That Remembers How You Work</span>
            <h2>Your Agents, Your Way</h2>
            <p>
              Give each agent a role, instructions, a workspace, and permissions. Keep their
              conversations together and return whenever you need them.
            </p>
            <button data-wb-primary="" onClick={newAgent}>
              <Plus size={17} />
              Create Your First Agent
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
