import { VoiceConversationControl } from "../../voice/VoiceConversationControl";
import { createContext, type ReactNode, useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import clawLogo from "../../assets/savage-claw.png";
import { isAgentOwnedThread } from "@t3tools/client-runtime/state/agent-owned-threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isElectron } from "../../env";
import { useAgentOwnedThreads } from "../../state/agentOwnedThreads";
import { useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentWorkspace } from "./AgentWorkspace";
import { CodeWorkspace } from "./CodeWorkspace";
import { ThreadWorkspace } from "./ThreadWorkspace";
import { SecretRequestPrompt } from "./SecretRequestPrompt";
import { WorkbenchNotifications, WorkbenchUsage } from "./WorkbenchActivity";
import { useWorkbenchPreferences } from "./workbenchPreferences";
import { parseThreadPath, resolveAgentTabView, resolveThreadTabTarget } from "./tabMemory";
import { useWorkbenchStore, type WorkbenchMode } from "./workbenchStore";
import {
  registerWorkbenchTabOpener,
  WORKBENCH_TAB_COMMANDS,
  WORKBENCH_TAB_ITEMS,
  workbenchTabForCommand,
} from "./workbenchTabs";
import "./workbench.css";

/** The top bar element the thread sidebar's toggle is rendered into; see `SidebarControl`. */
export const WorkbenchSidebarSlotContext = createContext<HTMLElement | null>(null);

export function WorkbenchShell({ children }: { children: ReactNode }) {
  const mode = useWorkbenchStore((state) => state.mode);
  const [sidebarSlot, setSidebarSlot] = useState<HTMLElement | null>(null);
  const setMode = useWorkbenchStore((state) => state.setMode);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const threads = useThreadShells();
  const agentOwnedThreads = useAgentOwnedThreads();
  const currentThreadIsAgentOwned = () => {
    const [environmentId, threadId] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return (
      !!environmentId &&
      !!threadId &&
      isAgentOwnedThread(agentOwnedThreads, environmentId as EnvironmentId, threadId)
    );
  };
  const rememberThread = useWorkbenchStore((state) => state.rememberThread);
  const selectedAgentId = useWorkbenchPreferences((state) => state.selectedAgentId);
  // The Threads tab reopens the thread it was last showing.
  const ordinaryThread = parseThreadPath(pathname);
  const ordinaryEnvironmentId = ordinaryThread?.environmentId;
  const ordinaryThreadId = ordinaryThread?.threadId;
  const onOrdinaryThread =
    !!ordinaryEnvironmentId &&
    !!ordinaryThreadId &&
    !isAgentOwnedThread(
      agentOwnedThreads,
      ordinaryEnvironmentId as EnvironmentId,
      ordinaryThreadId,
    );
  useEffect(() => {
    if (mode === "thread" && onOrdinaryThread && ordinaryEnvironmentId && ordinaryThreadId)
      rememberThread({ environmentId: ordinaryEnvironmentId, threadId: ordinaryThreadId });
  }, [mode, onOrdinaryThread, ordinaryEnvironmentId, ordinaryThreadId, rememberThread]);
  // Threads is for ordinary sessions. Arriving there reopens the thread that was open last time,
  // or, when it is gone and an agent's conversation is on screen, the most recent ordinary thread.
  const openThreadsTab = () => {
    const target = resolveThreadTabTarget({
      pathname,
      remembered: useWorkbenchStore.getState().lastThread,
      threads,
      owned: agentOwnedThreads,
    });
    if (target.kind === "thread")
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: target.environmentId as EnvironmentId,
          threadId: target.threadId as ThreadId,
        }),
      });
    else if (target.kind === "home") void navigate({ to: "/" });
  };
  // What a tab button does, shared with the shortcuts and the command palette.
  const selectTab = (id: WorkbenchMode) => {
    if (id === "agent") {
      // On a phone the roster is hidden beside a conversation, so a second tap opens it.
      const store = useWorkbenchStore.getState();
      const openRoster =
        mode === "agent" &&
        store.agentView === "conversation" &&
        window.matchMedia("(max-width: 700px)").matches;
      // Arriving from another tab reopens the view it was left on (the team board when
      // that agent is gone). Tapping the tab again leaves the board (or the check-in
      // inbox, the campaigns or the schedules) be.
      if (mode !== "agent")
        store.setAgentView(
          resolveAgentTabView({
            currentIsAgentOwned: currentThreadIsAgentOwned(),
            remembered: store.agentView,
            hasSelectedAgent: selectedAgentId !== null,
          }),
        );
      else if (
        store.agentView !== "board" &&
        store.agentView !== "checkins" &&
        store.agentView !== "campaigns" &&
        store.agentView !== "schedules"
      )
        store.setAgentView(openRoster ? "details" : "conversation");
    }
    setMode(id);
    if (pathname.startsWith("/settings") || pathname === "/usage") void navigate({ to: "/" });
    else if (id === "thread" && (mode !== "thread" || currentThreadIsAgentOwned()))
      openThreadsTab();
  };
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const tabShortcuts = {
    agent: shortcutLabelForCommand(keybindings, WORKBENCH_TAB_COMMANDS.agent),
    code: shortcutLabelForCommand(keybindings, WORKBENCH_TAB_COMMANDS.code),
    thread: shortcutLabelForCommand(keybindings, WORKBENCH_TAB_COMMANDS.thread),
  } satisfies Record<WorkbenchMode, string | null>;
  const selectTabRef = useRef(selectTab);
  useEffect(() => {
    selectTabRef.current = selectTab;
  });
  useEffect(() => {
    registerWorkbenchTabOpener((id) => selectTabRef.current(id));
    return () => registerWorkbenchTabOpener(null);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const tab = workbenchTabForCommand(resolveShortcutCommand(event, keybindings));
      if (tab === null) return;
      event.preventDefault();
      event.stopPropagation();
      selectTabRef.current(tab);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
  return (
    <div
      data-wb-shell=""
      data-workbench-mode={mode}
      data-workbench-desktop={isElectron ? "true" : undefined}
    >
      <header className="drag-region" data-wb-topbar="">
        <div data-wb-topbar-start="">
          <div data-wb-brand="">
            <img src={clawLogo} alt="" width={22} height={22} />
            CodeWrench
          </div>
          <div ref={setSidebarSlot} data-wb-sidebar-slot="" />
        </div>
        <nav data-wb-modes="" aria-label="Work Mode">
          {WORKBENCH_TAB_ITEMS.map(({ mode: id, label, Icon }) => (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <button type="button" aria-pressed={mode === id} onClick={() => selectTab(id)} />
                }
              >
                <Icon size={15} />
                {label}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {label}
                {tabShortcuts[id] ? ` (${tabShortcuts[id]})` : ""}
              </TooltipPopup>
            </Tooltip>
          ))}
        </nav>
        <div data-wb-topbar-end="">
          <VoiceConversationControl
            target={
              ordinaryThread && currentThreadIsAgentOwned()
                ? {
                    environmentId: ordinaryThread.environmentId as EnvironmentId,
                    threadId: ordinaryThread.threadId as ThreadId,
                    name:
                      threads.find(
                        (thread) =>
                          thread.id === ordinaryThread.threadId &&
                          thread.environmentId === ordinaryThread.environmentId,
                      )?.title ?? "Agent",
                  }
                : null
            }
          />
          <WorkbenchUsage />
          <WorkbenchNotifications />
        </div>
      </header>
      <WorkbenchSidebarSlotContext value={sidebarSlot}>
        <div data-wb-body="">{children}</div>
      </WorkbenchSidebarSlotContext>
      {/* Mounted once here so a secret request is shown whichever tab is open. */}
      <SecretRequestPrompt />
    </div>
  );
}

export function WorkbenchContent({
  children,
  active = true,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const mode = useWorkbenchStore((state) => state.mode);
  const agent = active && mode === "agent";
  const code = active && mode === "code";
  const agentView = useWorkbenchStore((state) => state.agentView);
  const showConversation = agent && agentView === "conversation";
  // Threads stay mounted behind Agent details and the Code grid so their state survives a tab switch.
  const runtimeHidden = code || (agent && !showConversation);
  return (
    <div data-wb-content="" data-wb-agent-conversation={showConversation ? "true" : undefined}>
      <div data-wb-runtime="" hidden={runtimeHidden} inert={runtimeHidden}>
        <ThreadWorkspace active={active && mode === "thread"}>{children}</ThreadWorkspace>
      </div>
      {agent && <AgentWorkspace railOnly={showConversation} />}
      {code && <CodeWorkspace />}
    </div>
  );
}
