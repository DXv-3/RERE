import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProviderDriverKind, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  Globe,
  GripVertical,
  LayoutList,
  ListChecks,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  NotebookPen,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { resolveShortcutCommand } from "../../keybindings";
import { randomUUID } from "../../lib/utils";
import { formatElapsedDurationLabel } from "../../timestampFormat";
import { useProjects } from "../../state/entities";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { projectEnvironment } from "../../state/projects";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { vcsEnvironment } from "../../state/vcs";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CodeBroadcastBar,
  CodeCustomTools,
  CodeDashboard,
  CodeLayoutsMenu,
  CodeTeamLauncher,
  type DashboardRow,
} from "./CodeWorkspaceControls";
import { restoreLayout, type SavedCodeLayout, snapshotLayout } from "./codeLayouts";
import { launchCommand, paneDrivers, paneEnvironment, paneModels } from "./codePaneLaunch";
import { advanceTasks, handTask, moveTask, taskLine } from "./codeTasks";
import { CodeTasksBoard } from "./CodeTasksBoard";
import { type CodeTeam, memberPrompt, worktreeBranch } from "./codeTeams";
import { type CodePane, type CodeWorkspaceState, useWorkbenchStore } from "./workbenchStore";
import {
  arrangeGrid,
  type GridEdge,
  type GridLayout,
  type GridPreset,
  gridPresets,
  moveGridPane,
  nudgeGridPane,
  type PaneActivity,
  byUrgency,
  paneActivity,
  reconcileGrid,
  resizeGridColumns,
  resizeGridRows,
  swapGridPanes,
} from "./workspaceLayout";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);

/** Each ghostty surface holds a GPU context; past this a workspace stops being glanceable anyway. */
const MAX_PANES = 12;
/** A CLI needs a moment to take over its shell after the launch line is typed. */
const LAUNCH_GRACE_MS = 4_000;
const tools: ReadonlyArray<{ kind: CodePane["kind"]; label: string }> = [
  { kind: "claude", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "shell", label: "Terminal" },
];
const empty: CodeWorkspaceState = { panes: [] };
const presetLabels: Record<GridPreset, string> = {
  tile: "Tile",
  columns: "Columns",
  rows: "Rows",
  pairs: "Two Wide",
};
// "Running" is a live program that does not report on itself; it may be waiting for input.
const activityLabels: Record<PaneActivity, string> = {
  starting: "Starting",
  shell: "Idle",
  running: "Running",
  working: "Working",
  "needs-you": "Needs You",
  idle: "Idle",
  ended: "Ended",
};

/**
 * The Code tab: a grid of real terminals per project, each running a coding CLI or a shell,
 * with an optional browser beside it. Sessions are owned by the server under a per-project
 * key, so panes keep running across tab switches and reattach after a reload.
 */
export function CodeWorkspace() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const selectedKey = useWorkbenchStore((state) => state.selectedCodeWorkspace);
  const select = useWorkbenchStore((state) => state.selectCodeWorkspace);
  const workspaces = useWorkbenchStore((state) => state.codeWorkspaces);
  const save = useWorkbenchStore((state) => state.saveCodeWorkspace);
  const customTools = useWorkbenchStore((state) =>
    environmentId ? state.customCodeTools[environmentId] : undefined,
  );
  const saveCustomTools = useWorkbenchStore((state) => state.saveCustomCodeTools);
  const [broadcasting, setBroadcasting] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  // When each CLI was last launched, so a pane is not called "back at shell" while it starts.
  const [launched, setLaunched] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const [restarts, setRestarts] = useState<Record<string, number>>({});
  const restarting = useRef(new Set<string>());
  const markLaunched = (id: string) => {
    setLaunched((current) => ({ ...current, [id]: Date.now() }));
    setTimeout(() => setNow(Date.now()), LAUNCH_GRACE_MS + 500);
  };
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, { reportFailure: false });
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, { reportFailure: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [focus, setFocus] = useState({ id: "", request: 0 });
  // Panes that rang the bell while the user was elsewhere. Cleared on focus.
  const [attention, setAttention] = useState<ReadonlySet<string>>(new Set());
  const setNeedsAttention = (id: string, needed: boolean) =>
    setAttention((current) => {
      if (current.has(id) === needed) return current;
      const next = new Set(current);
      if (needed) next.add(id);
      else next.delete(id);
      return next;
    });
  const sessions = useKnownTerminalSessions({ environmentId, threadId: null });
  const providers = useAtomValue(primaryServerProvidersAtom);
  const sessionOf = (projectId: string, paneId: string) =>
    sessions.find(
      (session) =>
        session.target.terminalId === paneId &&
        session.target.threadId === `workbench-code:${projectId}`,
    )?.state;
  const activityOf = (projectId: string, paneId: string) =>
    paneActivity(sessionOf(projectId, paneId));

  // Waiting on the user: the CLI says so, or it says nothing about itself and rang the bell.
  const waiting = new Set<string>();
  for (const session of sessions) {
    const { agentState } = session.state;
    const id = session.target.terminalId;
    if (agentState === "needs-you" || (agentState === null && attention.has(id))) waiting.add(id);
  }

  const keyOf = (projectId: string) => `${environmentId}:${projectId}`;
  // Elapsed times on the dashboard move in coarse steps; nothing repaints between them.
  useEffect(() => {
    if (!dashboardOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [dashboardOpen]);
  // Handed cards follow their pane: when its turn ends, the card moves to Review.
  useEffect(() => {
    for (const candidate of projects) {
      const candidateKey = keyOf(candidate.id);
      const state = workspaces[candidateKey];
      if (!state?.tasks?.length) continue;
      const next = advanceTasks(state.tasks, (paneId) =>
        state.panes.some((pane) => pane.id === paneId)
          ? activityOf(candidate.id, paneId)
          : undefined,
      );
      if (next !== state.tasks) save(candidateKey, { ...state, tasks: next });
    }
  });
  const dashboardRows = (): ReadonlyArray<DashboardRow> =>
    byUrgency(
      projects.flatMap((candidate) =>
        (workspaces[keyOf(candidate.id)]?.panes ?? []).map((pane) => {
          const activity = waiting.has(pane.id) ? "needs-you" : activityOf(candidate.id, pane.id);
          // The summary's time moves only when the session's state does.
          const since = sessionOf(candidate.id, pane.id)?.summary?.updatedAt;
          return {
            id: pane.id,
            projectId: candidate.id,
            label: pane.label,
            workspace: candidate.title,
            activity,
            status: activityLabels[activity],
            elapsed: since ? formatElapsedDurationLabel(since, now) : "",
          };
        }),
      ),
    );
  const jumpTo = (projectId: string, paneId: string) => {
    setNeedsAttention(paneId, false);
    if (maximized && maximized !== paneId) setMaximized(null);
    select(keyOf(projectId));
    setFocus((current) => ({ id: paneId, request: current.request + 1 }));
  };
  const project =
    projects.find((candidate) => keyOf(candidate.id) === selectedKey) ?? projects[0] ?? null;
  const key = project ? keyOf(project.id) : null;
  const workspace = (key && workspaces[key]) || empty;
  const threadId = project ? ThreadId.make(`workbench-code:${project.id}`) : null;
  const threadRef = environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null;
  const layout = reconcileGrid(
    workspace.panes.map((pane) => pane.id),
    workspace.layout,
  );
  // Reads the saved workspace at call time: adding two panes quickly must not drop the first.
  const current = () => (key && useWorkbenchStore.getState().codeWorkspaces[key]) || empty;
  const update = (next: (latest: CodeWorkspaceState) => Partial<CodeWorkspaceState>) => {
    if (!key) return;
    const latest = current();
    save(key, { ...latest, ...next(latest) });
  };

  // `prompt` is the CLI's opening message. It is sent with the first launch only, so a
  // restart or relaunch never repeats a task.
  const startPane = async (pane: CodePane, prompt?: string) => {
    if (!environmentId || !project || !threadId) return false;
    const opened = await openTerminal({
      environmentId,
      input: {
        threadId,
        terminalId: pane.id,
        cwd: pane.worktree?.path ?? project.workspaceRoot,
        ...(pane.worktree ? { worktreePath: pane.worktree.path } : {}),
        env: paneEnvironment(pane.kind),
      },
    });
    if (opened._tag === "Failure") return false;
    relaunch(pane, prompt);
    return true;
  };
  const relaunch = (pane: CodePane, prompt?: string) => {
    const command = launchCommand(pane.kind, pane.model?.slug, pane.command, prompt);
    if (!command || !environmentId || !threadId) return;
    markLaunched(pane.id);
    void writeTerminal({
      environmentId,
      input: { threadId, terminalId: pane.id, data: `${command}\r` },
    });
  };
  // Ends the session and starts a fresh one in the same pane, keeping its place and name.
  const restartPane = async (pane: CodePane) => {
    if (!environmentId || !threadId || restarting.current.has(pane.id)) return;
    restarting.current.add(pane.id);
    await closeTerminal({
      environmentId,
      input: { threadId, terminalId: pane.id, deleteHistory: true },
    });
    const started = await startPane(pane);
    restarting.current.delete(pane.id);
    if (!started) setError(`Could not restart ${pane.label}.`);
    setRestarts((current) => ({ ...current, [pane.id]: (current[pane.id] ?? 0) + 1 }));
  };
  // A CLI pane with nothing running in it has dropped back to its shell.
  const atShell = (pane: CodePane) =>
    !!project &&
    pane.kind !== "shell" &&
    activityOf(project.id, pane.id) === "shell" &&
    now - (launched[pane.id] ?? 0) > LAUNCH_GRACE_MS;
  const addPane = async (spec: Omit<CodePane, "id">) => {
    if (!project || busy) return;
    if (current().panes.length >= MAX_PANES) {
      setError(`A workspace holds up to ${MAX_PANES} terminals. Close one to add another.`);
      return;
    }
    setBusy(true);
    setError("");
    const count = current().panes.filter((pane) => pane.label.startsWith(spec.label)).length;
    const pane = {
      ...spec,
      id: `code-${randomUUID()}`,
      label: count ? `${spec.label} ${count + 1}` : spec.label,
    };
    const started = await startPane(pane);
    setBusy(false);
    if (!started) {
      setError(`Could not start a terminal in ${project.workspaceRoot}.`);
      return;
    }
    update((latest) => ({ panes: [...latest.panes, pane] }));
  };
  const launchTeam = async (team: CodeTeam) => {
    if (!project || !environmentId || busy) return;
    if (current().panes.length + team.members.length > MAX_PANES) return;
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const [index, member] of team.members.entries()) {
      const id = `code-${randomUUID()}`;
      const label =
        member.role.trim() || `${member.kind === "codex" ? "Codex" : "Claude Code"} ${index + 1}`;
      let worktree: CodePane["worktree"];
      if (team.isolate) {
        const created = await createWorktree({
          environmentId,
          input: {
            cwd: project.workspaceRoot,
            refName: "HEAD",
            newRefName: worktreeBranch(member.role, id),
            path: null,
          },
        });
        if (created._tag !== "Success") {
          failed.push(label);
          continue;
        }
        worktree = { path: created.value.worktree.path, branch: created.value.worktree.refName };
      }
      const pane: CodePane = { id, kind: member.kind, label, ...(worktree ? { worktree } : {}) };
      if (await startPane(pane, memberPrompt(member, team.task)))
        update((latest) => ({ panes: [...latest.panes, pane] }));
      else failed.push(label);
    }
    setBusy(false);
    if (failed.length > 0)
      setError(
        team.isolate
          ? `Could not start ${failed.join(", ")}. A separate worktree needs a git repository with at least one commit.`
          : `Could not start ${failed.join(", ")}.`,
      );
  };
  // Removes a pane's worktree only when git agrees it is clean; otherwise it stays.
  const closeAndRemoveWorktree = async (pane: CodePane) => {
    if (!project || !environmentId || !pane.worktree) return;
    removePane(pane.id, true);
    const removed = await removeWorktree({
      environmentId,
      input: { cwd: project.workspaceRoot, path: pane.worktree.path },
    });
    if (removed._tag !== "Success")
      setError(
        `Kept the worktree for ${pane.label} at ${pane.worktree.path}. It has changes that are not committed, or it could not be removed.`,
      );
  };
  const openLayout = async (saved: SavedCodeLayout) => {
    // Opening over running sessions would have to close them; the user does that first.
    if (!project || busy || current().panes.length > 0) return;
    setBusy(true);
    setError("");
    const restored = restoreLayout(
      { ...saved, panes: saved.panes.slice(0, MAX_PANES) },
      () => `code-${randomUUID()}`,
    );
    const started: CodePane[] = [];
    for (const pane of restored.panes) if (await startPane(pane)) started.push(pane);
    setBusy(false);
    if (started.length < restored.panes.length)
      setError(`Opened ${started.length} of ${restored.panes.length} terminals in this layout.`);
    update(() => ({
      panes: started,
      layout: restored.layout,
      browserOpen: saved.browserOpen,
      ...(saved.browserUrl ? { browserUrl: saved.browserUrl } : {}),
    }));
  };
  const broadcast = (ids: readonly string[], text: string) => {
    if (!environmentId || !threadId) return;
    for (const id of ids)
      void writeTerminal({
        environmentId,
        input: { threadId, terminalId: id, data: `${text}\r` },
      });
  };
  const removePane = (id: string, closeSession: boolean) => {
    if (closeSession && environmentId && threadId)
      void closeTerminal({
        environmentId,
        input: { threadId, terminalId: id, deleteHistory: true },
      });
    if (maximized === id) setMaximized(null);
    update((latest) => ({ panes: latest.panes.filter((pane) => pane.id !== id) }));
  };

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The pane that last held focus; shortcuts act on it.
  const active = useRef<string | null>(null);
  const onShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    // Typing in a name, the broadcast bar or a menu is not a pane command.
    const editing = target?.matches?.("input, select, textarea") === true;
    const command = resolveShortcutCommand(event, keybindings, {
      context: { codeTabFocus: true, terminalFocus: !editing, editableFocus: editing },
    });
    const order = layout.rows.flat();
    const here = active.current && order.includes(active.current) ? active.current : null;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (command === "terminal.new") {
      handled();
      void addPane(tools.find((tool) => tool.kind === "shell")!);
    } else if (command === "terminal.close" && here) {
      handled();
      removePane(here, true);
    } else if (command === "codeTab.toggleMaximized" && here) {
      handled();
      setMaximized((current) => (current === here ? null : here));
    } else if (
      (command === "codeTab.nextPane" || command === "codeTab.previousPane") &&
      order.length > 0
    ) {
      handled();
      const step = command === "codeTab.nextPane" ? 1 : -1;
      const index = here ? order.indexOf(here) : step > 0 ? -1 : 0;
      const next = order[(index + step + order.length) % order.length]!;
      if (maximized && maximized !== next) setMaximized(next);
      active.current = next;
      setFocus((current) => ({ id: next, request: current.request + 1 }));
    }
  };

  return (
    // Capture phase: the terminal surface would otherwise send the chord to the CLI.
    <div data-wb-code="" onKeyDownCapture={onShortcut}>
      <aside data-wb-code-rail="" aria-label="Workspaces">
        <h2>Workspaces</h2>
        {projects.map((candidate) => {
          const panes = workspaces[keyOf(candidate.id)]?.panes ?? [];
          return (
            <div key={candidate.id} data-wb-code-workspace="">
              <button
                type="button"
                aria-pressed={candidate.id === project?.id}
                onClick={() => {
                  setMaximized(null);
                  select(keyOf(candidate.id));
                }}
              >
                <span>{candidate.title}</span>
                {panes.some((pane) => waiting.has(pane.id)) && (
                  <small data-attention="true">
                    {panes.filter((pane) => waiting.has(pane.id)).length} waiting
                  </small>
                )}
                {panes.length > 0 && <small>{panes.length}</small>}
              </button>
              {panes.map((pane) => {
                const activity = activityOf(candidate.id, pane.id);
                return (
                  <button
                    key={pane.id}
                    type="button"
                    data-wb-code-session=""
                    data-attention={waiting.has(pane.id) ? "true" : undefined}
                    aria-label={`${pane.label}, ${waiting.has(pane.id) ? "Needs You" : activityLabels[activity]}`}
                    onClick={() => jumpTo(candidate.id, pane.id)}
                  >
                    <i aria-hidden="true" data-activity={activity} />
                    <span>{pane.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {projects.length === 0 && (
          <>
            <p>
              No project folders yet. Add one from the Threads tab, or start in a personal folder.
            </p>
            <button
              type="button"
              disabled={!environmentId || busy}
              onClick={() => {
                if (!environmentId) return;
                setBusy(true);
                void ensureScratch({ environmentId, input: {} }).then((result) => {
                  setBusy(false);
                  if (result._tag === "Failure") setError("Could not prepare a personal folder.");
                });
              }}
            >
              <Plus size={14} />
              Use Personal Folder
            </button>
          </>
        )}
      </aside>
      <div data-wb-code-main="">
        <div data-wb-code-bar="">
          <strong>{project?.title ?? "Code"}</strong>
          <span>{project?.workspaceRoot}</span>
          {tools.map((tool) => {
            const models = paneModels(providers, tool.kind);
            return (
              <span key={tool.kind} data-wb-code-launch="">
                <button
                  type="button"
                  disabled={!project || busy}
                  onClick={() => void addPane(tool)}
                >
                  <Plus size={13} />
                  {tool.label}
                </button>
                {models.length > 0 && (
                  <select
                    aria-label={`Start ${tool.label} With A Model`}
                    value=""
                    disabled={!project || busy}
                    onChange={(event) => {
                      const model = models.find((item) => item.slug === event.target.value);
                      if (model) void addPane({ ...tool, model });
                    }}
                  >
                    <option value="">Model</option>
                    {models.map((model) => (
                      <option key={model.slug} value={model.slug}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            );
          })}
          {(customTools ?? []).map((tool) => (
            <button
              key={tool.name}
              type="button"
              disabled={!project || busy}
              onClick={() =>
                void addPane({ kind: "custom", label: tool.name, command: tool.command })
              }
            >
              <Plus size={13} />
              {tool.name}
            </button>
          ))}
          <CodeCustomTools
            tools={customTools ?? []}
            onSave={(tools) => environmentId && saveCustomTools(environmentId, tools)}
          />
          <CodeLayoutsMenu
            saved={workspace.savedLayouts ?? []}
            canSave={workspace.panes.length > 0}
            canOpen={!!project && !busy && workspace.panes.length === 0}
            onSave={(name) =>
              update((latest) => ({
                savedLayouts: [
                  ...(latest.savedLayouts ?? []).filter((item) => item.name !== name),
                  snapshotLayout(name, latest.panes, layout, latest.browserOpen === true),
                ],
              }))
            }
            onDelete={(name) =>
              update((latest) => ({
                savedLayouts: (latest.savedLayouts ?? []).filter((item) => item.name !== name),
              }))
            }
            onOpen={(saved) => void openLayout(saved)}
          />
          <CodeTeamLauncher
            saved={workspace.savedTeams ?? []}
            capacity={MAX_PANES - workspace.panes.length}
            disabled={!project || busy}
            onLaunch={(team) => void launchTeam(team)}
            onSave={(team) =>
              update((latest) => ({
                savedTeams: [
                  ...(latest.savedTeams ?? []).filter((item) => item.name !== team.name),
                  team,
                ],
              }))
            }
            onDelete={(name) =>
              update((latest) => ({
                savedTeams: (latest.savedTeams ?? []).filter((item) => item.name !== name),
              }))
            }
          />
          <button
            type="button"
            aria-pressed={broadcasting}
            disabled={workspace.panes.length < 2}
            onClick={() => setBroadcasting((open) => !open)}
          >
            Broadcast
          </button>
          <select
            aria-label="Arrange Terminals"
            value=""
            disabled={workspace.panes.length < 2}
            onChange={(event) => {
              const preset = gridPresets.find((candidate) => candidate === event.target.value);
              if (!preset) return;
              setMaximized(null);
              update(() => ({ layout: arrangeGrid(layout, preset) }));
            }}
          >
            <option value="">Arrange</option>
            {gridPresets.map((preset) => (
              <option key={preset} value={preset}>
                {presetLabels[preset]}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={dashboardOpen}
            onClick={() => {
              setNow(Date.now());
              setDashboardOpen((open) => !open);
            }}
          >
            <LayoutList size={13} />
            Dashboard
          </button>
          <button
            type="button"
            aria-pressed={workspace.browserOpen === true}
            disabled={!project}
            onClick={() => update((latest) => ({ browserOpen: !latest.browserOpen }))}
          >
            <Globe size={13} />
            Browser
          </button>
          <button
            type="button"
            aria-pressed={workspace.tasksOpen === true}
            disabled={!project}
            onClick={() => update((latest) => ({ tasksOpen: !latest.tasksOpen }))}
          >
            <ListChecks size={13} />
            Tasks
          </button>
          <button
            type="button"
            aria-pressed={workspace.notesOpen === true}
            disabled={!project}
            onClick={() => update((latest) => ({ notesOpen: !latest.notesOpen }))}
          >
            <NotebookPen size={13} />
            Notes
          </button>
        </div>
        {broadcasting && workspace.panes.length > 1 && (
          <CodeBroadcastBar panes={workspace.panes} waiting={waiting} onSend={broadcast} />
        )}
        {error && <p role="alert">{error}</p>}
        <div data-wb-code-stage="">
          {project && threadRef && workspace.panes.length > 0 ? (
            <CodeGrid
              key={key}
              layout={layout}
              panes={workspace.panes}
              maximized={maximized}
              activity={(id) => activityOf(project.id, id)}
              attention={waiting}
              atShell={(id) => {
                const pane = workspace.panes.find((item) => item.id === id);
                return !!pane && atShell(pane);
              }}
              onRelaunch={(id) => {
                const pane = workspace.panes.find((item) => item.id === id);
                if (pane) relaunch(pane);
              }}
              onRestart={(id) => {
                const pane = workspace.panes.find((item) => item.id === id);
                if (pane) void restartPane(pane);
              }}
              onAttended={(id) => {
                active.current = id;
                setNeedsAttention(id, false);
              }}
              onLayout={(next) => update(() => ({ layout: next }))}
              onMaximize={setMaximized}
              onRename={(id, label) =>
                update((latest) => ({
                  panes: latest.panes.map((pane) => (pane.id === id ? { ...pane, label } : pane)),
                }))
              }
              onClose={(id) => removePane(id, true)}
              onRemoveWorktree={(id) => {
                const pane = workspace.panes.find((item) => item.id === id);
                if (pane) void closeAndRemoveWorktree(pane);
              }}
            >
              {(pane, visible) => (
                <CodeTerminal
                  key={`${pane.id}:${restarts[pane.id] ?? 0}`}
                  threadRef={threadRef}
                  pane={pane}
                  cwd={project.workspaceRoot}
                  visible={visible}
                  focusRequest={focus.id === pane.id ? focus.request : 0}
                  onAttention={() => setNeedsAttention(pane.id, true)}
                  onExited={() => {
                    if (!restarting.current.has(pane.id)) removePane(pane.id, false);
                  }}
                />
              )}
            </CodeGrid>
          ) : (
            <div data-wb-code-empty="">
              <h3>{project ? "Start A Session" : "Choose A Workspace"}</h3>
              <p>
                {project
                  ? "Open Claude Code, Codex, a plain terminal or your own CLI in this folder, or open a saved layout. Add as many as you need and arrange them side by side."
                  : "Pick a project folder on the left to open terminals in it."}
              </p>
            </div>
          )}
          {dashboardOpen && (
            <CodeDashboard rows={dashboardRows()} onOpen={(row) => jumpTo(row.projectId, row.id)} />
          )}
          {project && workspace.tasksOpen && (
            <CodeTasksBoard
              tasks={workspace.tasks ?? []}
              // A pane can take a task when its CLI is up and not in the middle of something.
              panes={workspace.panes.filter((pane) => {
                const activity = activityOf(project.id, pane.id);
                return (
                  pane.kind !== "shell" &&
                  !waiting.has(pane.id) &&
                  (activity === "idle" || activity === "running")
                );
              })}
              paneLabel={(id) => workspace.panes.find((pane) => pane.id === id)?.label}
              onAdd={(text) =>
                update((latest) => ({
                  tasks: [...(latest.tasks ?? []), { id: randomUUID(), text, column: "todo" }],
                }))
              }
              onHand={(id, paneId) => {
                const task = workspace.tasks?.find((item) => item.id === id);
                if (!task || !environmentId || !threadId) return;
                void writeTerminal({
                  environmentId,
                  input: { threadId, terminalId: paneId, data: `${taskLine(task.text)}\r` },
                });
                update((latest) => ({ tasks: handTask(latest.tasks ?? [], id, paneId) }));
              }}
              onMove={(id, column) =>
                update((latest) => ({ tasks: moveTask(latest.tasks ?? [], id, column) }))
              }
              onDelete={(id) =>
                update((latest) => ({
                  tasks: (latest.tasks ?? []).filter((item) => item.id !== id),
                }))
              }
            />
          )}
          {project && workspace.notesOpen && (
            <aside data-wb-code-notes="" aria-label="Workspace Notes">
              <textarea
                aria-label={`Notes For ${project.title}`}
                placeholder="Notes for this workspace. Saved as you type."
                maxLength={20_000}
                value={workspace.notes ?? ""}
                onChange={(event) => update(() => ({ notes: event.target.value }))}
              />
            </aside>
          )}
          {project && threadRef && workspace.browserOpen && (
            <div data-wb-code-browser="">
              <Suspense fallback={null}>
                <PreviewPanel
                  mode="embedded"
                  threadRef={threadRef}
                  configuredUrls={workspace.browserUrl ? [workspace.browserUrl] : []}
                  visible
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeTerminal({
  threadRef,
  pane,
  cwd,
  visible,
  focusRequest,
  onAttention,
  onExited,
}: {
  threadRef: ScopedThreadRef;
  pane: CodePane;
  cwd: string;
  visible: boolean;
  /** Changes when the rail asks for this terminal; zero means leave focus alone. */
  focusRequest: number;
  onAttention: () => void;
  onExited: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const host = useRef<HTMLDivElement>(null);
  // The terminal refits when this changes; panes resize whenever the grid or window does.
  const [size, setSize] = useState({ epoch: 0, height: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = Math.round(entry?.contentRect.height ?? 0);
      setSize((current) => ({ epoch: current.epoch + 1, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} data-wb-code-terminal="">
      <TerminalViewport
        advancedTypography={advancedTypography}
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId={pane.id}
        terminalLabel={pane.label}
        cwd={cwd}
        onSessionExited={onExited}
        onBell={() => {
          // A bell in the terminal the user is typing in needs no flag.
          if (!host.current?.contains(document.activeElement)) onAttention();
        }}
        focusRequestId={focusRequest}
        autoFocus={focusRequest > 0}
        visible={visible}
        resizeEpoch={size.epoch}
        drawerHeight={size.height}
        keybindings={keybindings}
      />
    </div>
  );
}

const paneMoves: ReadonlyArray<{ direction: GridEdge; label: string }> = [
  { direction: "left", label: "Move Left" },
  { direction: "right", label: "Move Right" },
  { direction: "top", label: "Move Up" },
  { direction: "bottom", label: "Move Down" },
];
type DropZone = GridEdge | "center";
/** The middle of a pane swaps places; its edges dock beside it. */
function dropZone(event: React.DragEvent<HTMLElement>): DropZone {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width;
  const y = (event.clientY - bounds.top) / bounds.height;
  if (Math.abs(x - 0.5) < 0.2 && Math.abs(y - 0.5) < 0.2) return "center";
  const distances: Array<[GridEdge, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
}

function CodeGrid({
  layout,
  panes,
  maximized,
  activity,
  attention,
  atShell,
  onRelaunch,
  onRestart,
  onAttended,
  onLayout,
  onMaximize,
  onRename,
  onClose,
  onRemoveWorktree,
  children,
}: {
  layout: GridLayout;
  panes: readonly CodePane[];
  maximized: string | null;
  activity: (id: string) => PaneActivity;
  attention: ReadonlySet<string>;
  atShell: (id: string) => boolean;
  onRelaunch: (id: string) => void;
  onRestart: (id: string) => void;
  onAttended: (id: string) => void;
  onLayout: (layout: GridLayout) => void;
  onMaximize: (id: string | null) => void;
  onRename: (id: string, label: string) => void;
  onClose: (id: string) => void;
  onRemoveWorktree: (id: string) => void;
  children: (pane: CodePane, visible: boolean) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; edge: DropZone } | null>(null);
  // The worktree pane whose close button was pressed and is waiting for an answer.
  const [closing, setClosing] = useState<string | null>(null);
  const resize = useRef<{ layout: GridLayout; start: number; span: number } | null>(null);
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const focused = maximized && byId.has(maximized) ? maximized : null;

  const separator = (
    orientation: "vertical" | "horizontal",
    label: string,
    apply: (base: GridLayout, delta: number) => GridLayout,
    span: (bounds: DOMRect) => number,
  ) => (
    <div
      role="separator"
      tabIndex={0}
      data-wb-code-separator={orientation}
      aria-label={label}
      aria-orientation={orientation}
      onPointerDown={(event) => {
        const bounds = (
          orientation === "vertical"
            ? event.currentTarget.closest("[data-wb-code-row]")
            : grid.current
        )?.getBoundingClientRect();
        if (event.button !== 0 || !bounds) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        resize.current = {
          layout,
          start: orientation === "vertical" ? event.clientX : event.clientY,
          span: Math.max(1, span(bounds)),
        };
      }}
      onPointerMove={(event) => {
        const current = resize.current;
        if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const position = orientation === "vertical" ? event.clientX : event.clientY;
        onLayout(apply(current.layout, (position - current.start) / current.span));
      }}
      onPointerUp={(event) => {
        resize.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        resize.current = null;
      }}
      onKeyDown={(event) => {
        const [negative, positive] =
          orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        onLayout(apply(layout, (event.key === negative ? -1 : 1) * (event.shiftKey ? 0.1 : 0.025)));
      }}
    />
  );

  return (
    <div
      ref={grid}
      data-wb-code-grid=""
      data-maximized={focused ? "true" : undefined}
      style={{
        gridTemplateRows: layout.rows
          .map((_, index) => `minmax(0, ${layout.rowWeights[index] ?? 1}fr)`)
          .join(" 6px "),
      }}
    >
      {layout.rows.map((row, rowIndex) => (
        // Keyed by position so adding a pane to a row does not remount its neighbours.
        // oxlint-disable-next-line react/no-array-index-key
        <div key={rowIndex} style={{ display: "contents" }}>
          {rowIndex > 0 &&
            separator(
              "horizontal",
              `Resize Row ${rowIndex}`,
              (base, delta) => resizeGridRows(base, rowIndex - 1, delta),
              (bounds) => bounds.height,
            )}
          <div
            data-wb-code-row=""
            style={{
              gridTemplateColumns: row
                .map((id) => `minmax(0, ${layout.weights[id] ?? 1}fr)`)
                .join(" 6px "),
            }}
          >
            {row.map((id, index) => {
              const pane = byId.get(id);
              if (!pane) return null;
              const visible = !focused || focused === id;
              return (
                <div key={id} style={{ display: "contents" }}>
                  {index > 0 &&
                    separator(
                      "vertical",
                      `Resize ${byId.get(row[index - 1]!)?.label ?? "Terminal"}`,
                      (base, delta) => resizeGridColumns(base, row[index - 1]!, id, delta),
                      (bounds) => bounds.width,
                    )}
                  <section
                    data-wb-code-pane=""
                    data-kind={pane.kind}
                    data-focused={focused === id ? "true" : undefined}
                    data-drop-edge={drop?.id === id ? drop.edge : undefined}
                    data-attention={attention.has(id) ? "true" : undefined}
                    aria-label={attention.has(id) ? `${pane.label}, Needs You` : pane.label}
                    onFocusCapture={() => onAttended(id)}
                    onPointerDownCapture={() => onAttended(id)}
                    onDragOver={(event) => {
                      if (!dragging.current || dragging.current === id) return;
                      event.preventDefault();
                      const edge = dropZone(event);
                      if (drop?.id !== id || drop.edge !== edge) setDrop({ id, edge });
                    }}
                    onDragLeave={() => setDrop((current) => (current?.id === id ? null : current))}
                    onDrop={(event) => {
                      const source = dragging.current;
                      dragging.current = null;
                      setDrop(null);
                      if (!source || source === id) return;
                      event.preventDefault();
                      const zone = dropZone(event);
                      onLayout(
                        zone === "center"
                          ? swapGridPanes(layout, source, id)
                          : moveGridPane(layout, source, id, zone),
                      );
                    }}
                  >
                    <header>
                      <span
                        draggable={!focused}
                        role="button"
                        tabIndex={-1}
                        aria-label={`Drag ${pane.label} To Move`}
                        onDragStart={(event) => {
                          dragging.current = id;
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", id);
                        }}
                        onDragEnd={() => {
                          dragging.current = null;
                          setDrop(null);
                        }}
                      >
                        <GripVertical size={13} />
                      </span>
                      <span data-wb-code-logo="" aria-hidden="true">
                        {paneDrivers[pane.kind] ? (
                          <ProviderInstanceIcon
                            driverKind={ProviderDriverKind.make(paneDrivers[pane.kind]!)}
                            displayName={pane.label}
                            badgeContent="none"
                            iconClassName="size-4"
                          />
                        ) : (
                          <SquareTerminal size={15} />
                        )}
                      </span>
                      {paneDrivers[pane.kind] && (
                        <Tooltip>
                          <TooltipTrigger render={<span data-wb-code-model="" />}>
                            {pane.model?.name ?? "Default"}
                          </TooltipTrigger>
                          <TooltipPopup>
                            The model this pane was started with. Changing the model inside the CLI
                            does not update this label.
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <i aria-hidden="true" data-activity={activity(id)} />
                      <input
                        aria-label={`Name For ${pane.label}`}
                        maxLength={60}
                        value={pane.label}
                        onChange={(event) => onRename(id, event.target.value)}
                      />
                      {pane.worktree && (
                        <Tooltip>
                          <TooltipTrigger render={<small data-wb-code-branch="" />}>
                            {pane.worktree.branch}
                          </TooltipTrigger>
                          <TooltipPopup>
                            This pane works in its own worktree at {pane.worktree.path}
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <small>
                        {attention.has(id)
                          ? "Needs You"
                          : atShell(id)
                            ? "Back At Shell"
                            : activityLabels[activity(id)]}
                      </small>
                      {atShell(id) && (
                        <button
                          type="button"
                          data-wb-code-relaunch=""
                          onClick={() => onRelaunch(id)}
                        >
                          Relaunch
                        </button>
                      )}
                      <details data-wb-code-menu="" data-wb-pane-menu="">
                        <summary aria-label={`More Actions For ${pane.label}`}>
                          <MoreHorizontal size={13} />
                        </summary>
                        <div>
                          {paneMoves.map((move) => {
                            const next = nudgeGridPane(layout, id, move.direction);
                            return (
                              <button
                                key={move.direction}
                                type="button"
                                disabled={next === layout || !!focused}
                                onClick={(event) => {
                                  event.currentTarget.closest("details")!.open = false;
                                  onLayout(next);
                                }}
                              >
                                {move.label}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.currentTarget.closest("details")!.open = false;
                              onRestart(id);
                            }}
                          >
                            Restart
                          </button>
                        </div>
                      </details>
                      <button
                        type="button"
                        aria-label={
                          focused === id ? `Restore ${pane.label}` : `Maximize ${pane.label}`
                        }
                        onClick={() => onMaximize(focused === id ? null : id)}
                      >
                        {focused === id ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      </button>
                      <button
                        type="button"
                        aria-label={`Close ${pane.label}`}
                        onClick={() => (pane.worktree ? setClosing(id) : onClose(id))}
                      >
                        <X size={13} />
                      </button>
                    </header>
                    {closing === id && pane.worktree && (
                      <div data-wb-code-close-ask="" role="group" aria-label="Close This Pane">
                        <span>Its worktree on {pane.worktree.branch}:</span>
                        <button type="button" onClick={() => onClose(id)}>
                          Keep It
                        </button>
                        <button type="button" onClick={() => onRemoveWorktree(id)}>
                          Remove It
                        </button>
                        <button type="button" onClick={() => setClosing(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                    <div data-wb-code-pane-body="">{children(pane, visible)}</div>
                  </section>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
