import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "../../lib/storage";
import { type CustomCodeTool, readCustomTools, type SavedCodeLayout } from "./codeLayouts";
import { type CodeTask, readTasks } from "./codeTasks";
import { readTeams, type SavedCodeTeam } from "./codeTeams";
import { readAgentView, readRememberedThread, type RememberedThread } from "./tabMemory";
import type { GridLayout, PaneLayout } from "./workspaceLayout";
import { isDetachedThreadWindow } from "./threadWindow";

export type WorkbenchMode = "agent" | "code" | "thread";
export const MAX_THREAD_PANES = 4;
export const threadPaneKey = (thread: RememberedThread) =>
  JSON.stringify([thread.environmentId, thread.threadId]);

export function readThreadPanes(value: unknown): RememberedThread[] {
  if (!Array.isArray(value)) return [];
  const panes: RememberedThread[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const thread = readRememberedThread(item);
    if (!thread || !thread.environmentId || seen.has(threadPaneKey(thread))) continue;
    seen.add(threadPaneKey(thread));
    panes.push(thread);
    if (panes.length === MAX_THREAD_PANES - 1) break;
  }
  return panes;
}
const codePaneKinds = ["claude", "codex", "shell", "custom"] as const;
export interface CodePane {
  /** Also the terminal id, so a pane reattaches to its running session after a reload. */
  id: string;
  kind: (typeof codePaneKinds)[number];
  label: string;
  /** The model the CLI was started with. The CLI can change it later without this knowing. */
  model?: { slug: string; name: string };
  /** The line a custom CLI pane types into its shell. */
  command?: string;
  /** The pane's own git worktree, when it does not work in the shared project folder. */
  worktree?: { path: string; branch: string };
}
/** One project's Code tab: its open terminals and how they are arranged. */
export interface CodeWorkspaceState {
  panes: CodePane[];
  layout?: Partial<GridLayout>;
  browserOpen?: boolean;
  browserUrl?: string;
  savedLayouts?: SavedCodeLayout[];
  savedTeams?: SavedCodeTeam[];
  tasks?: ReadonlyArray<CodeTask>;
  tasksOpen?: boolean;
  /** Free-form notes kept with the workspace. */
  notes?: string;
  notesOpen?: boolean;
}
function readCodeWorkspaces(value: unknown): Record<string, CodeWorkspaceState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const panes = (entry as Partial<CodeWorkspaceState> | null)?.panes;
      if (!Array.isArray(panes)) return [];
      const valid = panes
        .filter(
          (pane): pane is CodePane =>
            typeof pane?.id === "string" &&
            typeof pane.label === "string" &&
            codePaneKinds.includes(pane.kind),
        )
        .map(({ id, kind, label, model, command, worktree }): CodePane => ({
          id,
          kind,
          label,
          ...(typeof worktree?.path === "string" && typeof worktree.branch === "string"
            ? { worktree: { path: worktree.path, branch: worktree.branch } }
            : {}),
          ...(typeof command === "string" ? { command } : {}),
          ...(typeof model?.slug === "string" && typeof model.name === "string"
            ? { model: { slug: model.slug, name: model.name } }
            : {}),
        }));
      const {
        layout,
        browserOpen,
        browserUrl,
        savedLayouts,
        savedTeams,
        notes,
        notesOpen,
        tasks,
        tasksOpen,
      } = entry as CodeWorkspaceState;
      return [
        [
          key,
          {
            panes: valid,
            ...(layout && typeof layout === "object" ? { layout } : {}),
            browserOpen: browserOpen === true,
            ...(typeof browserUrl === "string" ? { browserUrl } : {}),
            ...(typeof notes === "string" ? { notes: notes.slice(0, 20_000) } : {}),
            notesOpen: notesOpen === true,
            savedTeams: readTeams(savedTeams),
            tasks: readTasks(tasks),
            tasksOpen: tasksOpen === true,
            // Shape is checked again when a layout is opened; a bad entry opens nothing.
            ...(Array.isArray(savedLayouts)
              ? {
                  savedLayouts: savedLayouts.filter(
                    (item) =>
                      typeof item?.name === "string" &&
                      Array.isArray(item.panes) &&
                      Array.isArray(item.layout?.rows),
                  ),
                }
              : {}),
          },
        ],
      ];
    }),
  );
}
/**
 * The Agent tab shows the team board, the check-in inbox, the campaigns, the schedules, one agent's conversation,
 * or the roster with details.
 */
export type AgentView =
  | "board"
  | "checkins"
  | "campaigns"
  | "schedules"
  | "conversation"
  | "details";

interface WorkbenchState {
  codeWorkspaces: Record<string, CodeWorkspaceState>;
  selectedCodeWorkspace: string | null;
  saveCodeWorkspace: (key: string, workspace: CodeWorkspaceState) => void;
  /** Custom CLI launchers, per environment. */
  customCodeTools: Record<string, CustomCodeTool[]>;
  saveCustomCodeTools: (environmentId: string, tools: CustomCodeTool[]) => void;
  selectCodeWorkspace: (key: string) => void;
  mode: WorkbenchMode;
  agentView: AgentView;
  /** Persisted, so the Agents tab reopens on the view it was left on. */
  setAgentView: (view: AgentView) => void;
  /** The ordinary thread the Threads tab was last showing. */
  lastThread: RememberedThread | null;
  rememberThread: (thread: RememberedThread) => void;
  threadPanes: RememberedThread[];
  setThreadPanes: (panes: RememberedThread[]) => void;
  layouts: Record<string, PaneLayout>;
  setMode: (mode: WorkbenchMode) => void;
  saveLayout: (key: string, layout: PaneLayout) => void;
}
const fallback = createMemoryStorage();
// A detached session starts alone and cannot overwrite the main window's layout/mode.
const detachedWindow = isDetachedThreadWindow();
const storage = {
  getItem: (key: string) => {
    try {
      return (detachedWindow ? sessionStorage : localStorage).getItem(key);
    } catch {
      return fallback.getItem(key);
    }
  },
  setItem: (key: string, value: string) => {
    try {
      (detachedWindow ? sessionStorage : localStorage).setItem(key, value);
    } catch {
      fallback.setItem(key, value);
    }
  },
  removeItem: (key: string) => {
    try {
      (detachedWindow ? sessionStorage : localStorage).removeItem(key);
    } catch {
      fallback.removeItem(key);
    }
  },
};

export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      mode: "thread",
      agentView: "conversation",
      setAgentView: (agentView) => set({ agentView }),
      lastThread: null,
      threadPanes: [],
      setThreadPanes: (threadPanes) => set({ threadPanes: readThreadPanes(threadPanes) }),
      rememberThread: (thread) =>
        set((state) =>
          state.lastThread?.environmentId === thread.environmentId &&
          state.lastThread.threadId === thread.threadId
            ? state
            : { lastThread: thread },
        ),
      layouts: {},
      codeWorkspaces: {},
      selectedCodeWorkspace: null,
      saveCodeWorkspace: (key, workspace) =>
        set((state) => ({ codeWorkspaces: { ...state.codeWorkspaces, [key]: workspace } })),
      selectCodeWorkspace: (selectedCodeWorkspace) => set({ selectedCodeWorkspace }),
      customCodeTools: {},
      saveCustomCodeTools: (environmentId, tools) =>
        set((state) => ({ customCodeTools: { ...state.customCodeTools, [environmentId]: tools } })),
      setMode: (mode) => set({ mode }),
      saveLayout: (key, layout) =>
        set((state) => ({ layouts: { ...state.layouts, [key]: layout } })),
    }),
    {
      name: detachedWindow ? "workbench:detached:v1" : "workbench:presentation:v1",
      storage: createJSONStorage(() => storage),
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== "object") return current;
        const value = persisted as Partial<WorkbenchState>;
        return {
          ...current,
          mode: value.mode === "agent" || value.mode === "code" ? value.mode : "thread",
          agentView: readAgentView(value.agentView),
          lastThread: readRememberedThread(value.lastThread),
          threadPanes: readThreadPanes(value.threadPanes),
          layouts:
            value.layouts && typeof value.layouts === "object" && !Array.isArray(value.layouts)
              ? value.layouts
              : {},
          codeWorkspaces: readCodeWorkspaces(value.codeWorkspaces),
          customCodeTools:
            value.customCodeTools && typeof value.customCodeTools === "object"
              ? Object.fromEntries(
                  Object.entries(value.customCodeTools).map(([key, tools]) => [
                    key,
                    readCustomTools(tools),
                  ]),
                )
              : {},
          selectedCodeWorkspace:
            typeof value.selectedCodeWorkspace === "string" ? value.selectedCodeWorkspace : null,
        };
      },
      partialize: (state) => ({
        mode: state.mode,
        agentView: state.agentView,
        lastThread: state.lastThread,
        threadPanes: state.threadPanes,
        layouts: state.layouts,
        codeWorkspaces: state.codeWorkspaces,
        customCodeTools: state.customCodeTools,
        selectedCodeWorkspace: state.selectedCodeWorkspace,
      }),
    },
  ),
);
