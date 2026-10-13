import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlayIcon,
  SettingsIcon,
} from "lucide-react";

import { isElectron } from "../../env";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  buildProjectOverview,
  PROJECT_OVERVIEW_GROUP_LABEL,
  PROJECT_OVERVIEW_GROUPS,
  PROJECT_OVERVIEW_NEED_LABEL,
  summarizeProjectOverview,
  type ProjectOverviewEntry,
  type ProjectOverviewGroup,
} from "./projectOverview";
import { useOpenProjectCoordinator } from "./useProjectCoordinator";
import { useProjectPause } from "./useProjectPause";
import type { ThreadShell } from "../../types";

const GROUP_BADGE: Record<
  ProjectOverviewGroup,
  "warning" | "info" | "secondary" | "success" | "outline"
> = {
  waiting: "warning",
  review: "info",
  working: "secondary",
  landing: "success",
  idle: "outline",
  resolved: "outline",
};

const NO_REFS: ReadonlyArray<never> = [];

/**
 * A project at a glance: its goal, the way into its coordinator, and every thread sorted by
 * what it needs. Threads arrive classified by `buildProjectOverview`; this only draws them.
 */
export function ProjectOverviewPage({ projectKey }: { projectKey: string }) {
  const navigate = useNavigate();
  const group = useSettingsProjectGroups().find((entry) => entry.projectKey === projectKey);
  const threads = useThreadShellsForProjectRefs(group?.memberProjectRefs ?? NO_REFS);
  const coordinator = useOpenProjectCoordinator();
  const pause = useProjectPause();

  if (group === undefined) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border" />
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Project Not Found</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or its machine is not connected.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SidebarInset>
    );
  }

  const representative = group.memberProjects[0]!;
  const groups = buildProjectOverview({
    threads,
    coordinatorThreadIds: new Set(
      group.memberProjects.flatMap((member) =>
        member.coordinatorThreadId ? [member.coordinatorThreadId] : [],
      ),
    ),
  });
  const summary = summarizeProjectOverview(groups);
  const withPullRequests = PROJECT_OVERVIEW_GROUPS.flatMap((name) => groups[name]).filter(
    (entry) => entry.pullRequest !== null,
  );

  const openThread = (thread: Pick<ThreadShell, "environmentId" | "id">) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId: thread.environmentId, threadId: thread.id }),
    });
  const paused = group.memberProjects.some((member) => (member.pausedAt ?? null) !== null);
  const togglePaused = async () => {
    const error = await pause.setPaused({
      members: group.memberProjects,
      threads,
      paused: !paused,
    });
    if (error !== null) toastManager.add({ type: "error", title: error });
  };
  const openCoordinator = async () => {
    const error = await coordinator.open(representative);
    if (error !== null) toastManager.add({ type: "error", title: error });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ProjectFavicon project={representative} className="size-5" />
            <h1 className="truncate text-sm font-medium">{group.displayName}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              disabled={coordinator.opening}
              onClick={() => void openCoordinator()}
            >
              <MessagesSquareIcon aria-hidden />
              Open Coordinator
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={pause.busy}
              onClick={() => void togglePaused()}
            >
              {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() =>
                void navigate({
                  to: "/settings/projects",
                  search: { project: group.projectKey, machine: undefined },
                })
              }
            >
              <SettingsIcon aria-hidden />
              Settings
            </Button>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
            {paused ? (
              <Alert variant="warning">
                <PauseIcon aria-hidden />
                <AlertDescription>
                  This project is paused. Its threads take no messages and nothing new starts,
                  including scheduled tasks and reports to the coordinator, until you resume it.
                </AlertDescription>
              </Alert>
            ) : null}
            <section aria-label="Goal">
              <h2 className="text-xs font-medium text-muted-foreground">Goal</h2>
              <p className="mt-1 text-sm">
                {representative.goal ?? (
                  <span className="text-muted-foreground">
                    No goal set. Add one in this project's settings.
                  </span>
                )}
              </p>
            </section>

            <section aria-label="Threads">
              <h2 className="text-sm font-medium">Threads</h2>
              <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
                {summary === ""
                  ? "No threads yet. Open the coordinator and give it some work."
                  : summary}
              </p>
              {PROJECT_OVERVIEW_GROUPS.filter((name) => groups[name].length > 0).map((name) => (
                <div key={name} className="mt-5">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {PROJECT_OVERVIEW_GROUP_LABEL[name]} ({groups[name].length})
                  </h3>
                  <ul className="mt-2 flex flex-col gap-1">
                    {groups[name].map((entry) => (
                      <li key={`${entry.thread.environmentId}:${entry.thread.id}`}>
                        <ThreadRow entry={entry} onOpen={() => openThread(entry.thread)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>

            {withPullRequests.length > 0 ? (
              <section aria-label="Pull requests">
                <h2 className="text-sm font-medium">Pull Requests</h2>
                <ul className="mt-2 flex flex-col gap-1">
                  {withPullRequests.map((entry) => {
                    const link = entry.pullRequest!;
                    return (
                      <li
                        key={`${link.host}/${link.repository}#${link.number}`}
                        className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                      >
                        <a
                          className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className="truncate">
                            {link.snapshot?.title ?? entry.thread.title}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {link.repository}#{link.number}
                          </span>
                          <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0" />
                        </a>
                        <Badge variant={GROUP_BADGE[entry.group]}>
                          {link.snapshot?.isDraft
                            ? "Draft"
                            : link.snapshot?.reviewDecision === "approved"
                              ? "Approved"
                              : link.snapshot?.reviewDecision === "changes-requested"
                                ? "Changes Requested"
                                : "Open"}
                        </Badge>
                        {link.snapshot?.checksState ? (
                          <Badge
                            variant={
                              link.snapshot.checksState === "failing"
                                ? "error"
                                : link.snapshot.checksState === "passing"
                                  ? "success"
                                  : "secondary"
                            }
                          >
                            Checks{" "}
                            {link.snapshot.checksState === "failing"
                              ? "Failing"
                              : link.snapshot.checksState === "passing"
                                ? "Passing"
                                : "Running"}
                          </Badge>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <section aria-label="Routines">
              <h2 className="text-sm font-medium">Routines</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Ask the coordinator to put work on a schedule, or manage every scheduled task in
                Settings.
              </p>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}
                >
                  Open Scheduled Tasks
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function ThreadRow({
  entry,
  onOpen,
}: {
  entry: ProjectOverviewEntry<ThreadShell>;
  onOpen: () => void;
}) {
  const { thread, group, need, pullRequest } = entry;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {pullRequest !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground">#{pullRequest.number}</span>
      ) : null}
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatRelativeTimeLabel(thread.updatedAt)}
      </span>
      <Badge variant={GROUP_BADGE[group]}>
        {need !== null ? PROJECT_OVERVIEW_NEED_LABEL[need] : PROJECT_OVERVIEW_GROUP_LABEL[group]}
      </Badge>
    </button>
  );
}
