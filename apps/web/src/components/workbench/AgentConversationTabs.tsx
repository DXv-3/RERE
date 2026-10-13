import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Plus, X } from "lucide-react";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  NEW_AGENT_CONVERSATION_EVENT,
  buildAgentConversationTabs,
  nextTabIndex,
  agentThreadsAfterClose,
  selectAfterClose,
  type AgentTabThread,
  type NewAgentConversationRequest,
} from "./agentConversationTabs.logic";
import { sessionKey, useWorkbenchPreferences } from "./workbenchPreferences";
import { useWorkbenchStore } from "./workbenchStore";
import { useThreadAgent } from "./useThreadAgent";
import { AGENTS_CHANGED_EVENT } from "./useAgentWorkspace";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const DOT_LABEL = {
  working: "Working",
  "needs-you": "Needs you",
  failed: "Needs attention",
  done: "Unread",
} as const;

/**
 * One tab per conversation of the agent whose chat is open, above the chat in the Agents tab.
 * Closing a tab archives its conversation (the usual undo toast applies); nothing is deleted.
 */
export function AgentConversationTabs({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const inAgentConversation = useWorkbenchStore(
    (s) => s.mode === "agent" && s.agentView === "conversation",
  );
  const agent = useThreadAgent(environmentId, threadId);
  const shells = useThreadShells();
  const lastVisited = useUiStateStore((s) => s.threadLastVisitedAtById);
  const navigate = useNavigate();
  const { archiveThread } = useThreadActions();
  const saveAgent = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const tabs = useMemo(() => {
    if (!agent) return [];
    const threads: AgentTabThread[] = shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => ({
        id: shell.id,
        title: shell.title,
        archivedAt: shell.archivedAt,
        status: resolveSidebarThreadStatus(shell),
        isUnread: hasUnseenCompletion({
          ...shell,
          lastVisitedAt: resolveThreadLastVisitedAt(
            shell.lastVisitedAt,
            lastVisited[scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))],
          ),
        }),
      }));
    return buildAgentConversationTabs({
      agentName: agent.profile.name,
      primaryThreadId: agent.primaryThreadId,
      threadIds: agent.threadIds,
      threads,
    });
  }, [agent, shells, environmentId, lastVisited]);

  const agentKey = agent ? sessionKey(environmentId, agent.profile.id) : null;
  const activeId = tabs.some((tab) => tab.id === threadId) ? threadId : null;

  // Returning to this agent reopens the conversation it was last showing.
  useEffect(() => {
    if (agentKey && activeId)
      useWorkbenchPreferences.getState().rememberConversation(agentKey, activeId);
  }, [agentKey, activeId]);

  useEffect(() => {
    if (activeId)
      tabRefs.current.get(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  if (!inAgentConversation || !agent || tabs.length === 0) return null;

  const open = (id: string) => {
    if (id === threadId) return;
    useWorkbenchPreferences.getState().assign(sessionKey(environmentId, id), agent.profile.id);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: ThreadId.make(id) }),
    });
  };

  const close = async (id: string) => {
    const tabIds = tabs.map((tab) => tab.id);
    const next = selectAfterClose({ tabIds, closedId: id, activeId });
    // The main conversation hands its role on before it closes, so the agent is never left without one.
    if (agent) {
      const after = agentThreadsAfterClose({
        primaryThreadId: agent.primaryThreadId,
        threadIds: agent.threadIds,
        tabIds,
        closedId: id,
      });
      if (after.primaryChanged) {
        const saved = await saveAgent({
          environmentId,
          input: {
            agent: {
              ...agent,
              primaryThreadId: after.primaryThreadId,
              threadIds: after.threadIds,
            },
            expectedRevision: agent.revision,
          },
        });
        if (saved._tag === "Failure") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not close this conversation",
              description: "The agent could not be updated. Refresh and try again.",
            }),
          );
          return;
        }
        window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
      }
    }
    // Archiving the open thread would send the reader to a blank draft, so move to the neighbour first.
    if (id === threadId && next) open(next);
    const result = await archiveThread(scopeThreadRef(environmentId, ThreadId.make(id)));
    if (result._tag === "Failure") {
      if (id === threadId) open(id);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not close this conversation",
          description: "A conversation that is still running cannot be closed yet.",
        }),
      );
    }
  };

  const addConversation = () => {
    if (creating) return;
    setCreating(true);
    const request: NewAgentConversationRequest = {
      environmentId,
      agentId: agent.profile.id,
      done: () => setCreating(false),
    };
    window.dispatchEvent(new CustomEvent(NEW_AGENT_CONVERSATION_EVENT, { detail: request }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const tab = tabs[index];
    if (event.key === "Delete" && tab?.closable) {
      event.preventDefault();
      void close(tab.id);
      return;
    }
    const target = nextTabIndex(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    const id = tabs[target]!.id;
    setFocusId(id);
    tabRefs.current.get(id)?.focus();
  };
  const rovingId = focusId && tabs.some((tab) => tab.id === focusId) ? focusId : activeId;

  return (
    <div data-wb-agent-tabs="">
      <div
        role="tablist"
        aria-label={`${agent.profile.name} conversations`}
        data-wb-agent-tablist=""
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusId(null);
        }}
      >
        {tabs.map((tab, index) => (
          <div key={tab.id} role="presentation" data-wb-agent-tab-item="">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="tab"
                    data-wb-agent-tab=""
                    data-dot={tab.dot ?? undefined}
                    aria-selected={tab.id === activeId}
                    tabIndex={tab.id === (rovingId ?? tabs[0]!.id) ? 0 : -1}
                    ref={(node) => {
                      if (node) tabRefs.current.set(tab.id, node);
                      else tabRefs.current.delete(tab.id);
                    }}
                    onClick={() => open(tab.id)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                  />
                }
              >
                {tab.dot && <span aria-hidden="true" data-wb-agent-tab-dot="" />}
                <span data-wb-agent-tab-label="">{tab.label}</span>
                {tab.dot && <span className="sr-only">, {DOT_LABEL[tab.dot]}</span>}
              </TooltipTrigger>
              <TooltipPopup side="bottom">{tab.fullTitle}</TooltipPopup>
            </Tooltip>
            {tab.closable && (
              <button
                type="button"
                tabIndex={-1}
                data-wb-agent-tab-close=""
                aria-label={`Close ${tab.fullTitle}`}
                onClick={() => void close(tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-wb-agent-tab-add=""
              aria-label="New chat"
              disabled={creating}
              onClick={addConversation}
            />
          }
        >
          <Plus size={14} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New chat</TooltipPopup>
      </Tooltip>
    </div>
  );
}
