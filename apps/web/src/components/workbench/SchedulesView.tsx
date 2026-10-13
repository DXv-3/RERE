import type { EnvironmentId, WorkbenchAgentGoal, WorkspaceAgent } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { goalErrorMessage } from "@t3tools/client-runtime/operations/agent-goals";
import { CheckCircle2Icon, ClockIcon, PauseIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  SCHEDULE_EMPTY_HINT,
  SCHEDULE_EXAMPLE_REQUEST,
  buildScheduleRows,
  scheduleSummary,
  type ScheduleRow,
  type ScheduleRowState,
} from "./schedules.logic";
import { useOpenThread } from "./useOpenThread";

function StateIcon({ state }: { readonly state: ScheduleRowState }) {
  switch (state) {
    case "running":
      return <Spinner size="sm" />;
    case "on":
      return <ClockIcon aria-hidden className="size-3.5" />;
    case "paused":
      return <PauseIcon aria-hidden className="size-3.5" />;
    case "done":
      return <CheckCircle2Icon aria-hidden className="size-3.5" />;
  }
}

type Notice = { readonly key: string; readonly kind: "error" | "info"; readonly text: string };

/**
 * Everything on this machine that runs by itself: scheduled tasks and every agent's goals, in one
 * list. Each row says what it does, who it belongs to, when it runs next and last ran, and what
 * the last run came to, with Pause or Resume, Run Now and Open Thread. A goal is paused through
 * the goal so its status stays true; a task through its own switch. It only uses commands that
 * already exist, so creating, editing and deleting stay where they are (Settings, Scheduled Tasks,
 * and an agent's goals).
 */
export function SchedulesView({
  environmentId,
  connected,
  agents,
  onAgentChange,
  onOpenAgent,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly agents: ReadonlyArray<WorkspaceAgent>;
  /** Hands up the saved agent a goal call returns, so the next agent save has its revision. */
  readonly onAgentChange: (agent: WorkspaceAgent, environmentId: EnvironmentId) => void;
  readonly onOpenAgent: (agent: WorkspaceAgent) => void;
}) {
  return (
    <section data-wb-schedules="" aria-label="Schedules">
      <h2>Schedules</h2>
      {environmentId === null || !connected ? (
        <p data-wb-board-summary="" aria-live="polite">
          Connect To Your Agent Workspace To See Schedules
        </p>
      ) : (
        <ConnectedSchedules
          environmentId={environmentId}
          agents={agents}
          onAgentChange={onAgentChange}
          onOpenAgent={onOpenAgent}
        />
      )}
    </section>
  );
}

function ConnectedSchedules({
  environmentId,
  agents,
  onAgentChange,
  onOpenAgent,
}: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<WorkspaceAgent>;
  readonly onAgentChange: (agent: WorkspaceAgent, environmentId: EnvironmentId) => void;
  readonly onOpenAgent: (agent: WorkspaceAgent) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const minute = useNowMinute();
  const rows = useMemo(
    () =>
      query.data === null
        ? []
        : buildScheduleRows({
            tasks: query.data.tasks,
            agents,
            now: new Date(`${minute}:00Z`),
          }),
    [query.data, agents, minute],
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const setGoalStatus = useAtomCommand(serverEnvironment.agentGoalsSetStatus, {
    reportFailure: false,
  });
  const openThread = useOpenThread(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "the example request" });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const fail = (key: string, error: unknown, goal: boolean) =>
    setNotice({
      key,
      kind: "error",
      text: goal
        ? goalErrorMessage(error)
        : error instanceof Error && error.message !== ""
          ? error.message
          : "That did not work. Try again.",
    });

  const act = async (row: ScheduleRow, action: "pause" | "resume" | "runNow") => {
    if (busy !== null) return;
    setBusy(row.key);
    setNotice(null);
    const status: WorkbenchAgentGoal["status"] = action === "pause" ? "paused" : "active";
    if (action !== "runNow" && row.kind === "goal" && row.agentId !== null && row.goalId !== null) {
      const result = await setGoalStatus({
        environmentId,
        input: { agentId: row.agentId, goalId: row.goalId, status },
      });
      setBusy(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          fail(row.key, squashAtomCommandFailure(result), true);
        return;
      }
      onAgentChange(result.value.agent, environmentId);
      return;
    }
    if (row.taskId === null) {
      setBusy(null);
      return;
    }
    const result =
      action === "runNow"
        ? await runNow({ environmentId, input: { id: row.taskId as never } })
        : await setEnabled({
            environmentId,
            input: { id: row.taskId as never, enabled: action === "resume" },
          });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) fail(row.key, squashAtomCommandFailure(result), false);
      return;
    }
    if (action === "runNow") {
      setNotice({
        key: row.key,
        kind: "info",
        text: "Started. The result shows here when it finishes.",
      });
    }
  };

  const open = (row: ScheduleRow) => {
    const agent = agents.find((entry) => entry.profile.id === row.agentId && !entry.archivedAt);
    if (agent !== undefined) onOpenAgent(agent);
    else if (row.threadId !== null) openThread(row.threadId);
  };

  if (query.error !== null && query.data === null) {
    return (
      <div role="alert" data-wb-error="">
        Could not load schedules. {query.error}{" "}
        <button type="button" onClick={query.refresh}>
          Try Again
        </button>
      </div>
    );
  }
  if (query.data === null) {
    return (
      <p data-wb-board-summary="" role="status" className="flex items-center gap-2">
        <Spinner size="sm" />
        Loading Schedules…
      </p>
    );
  }

  return (
    <>
      <p data-wb-board-summary="" aria-live="polite">
        {scheduleSummary(rows)}
      </p>
      {query.error !== null ? (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            Updates stopped arriving, so this may be out of date. {query.error}{" "}
            <button type="button" onClick={query.refresh}>
              Try Again
            </button>
          </AlertDescription>
        </Alert>
      ) : null}
      {rows.length === 0 ? (
        <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
          <p className="text-sm font-medium">Nothing Runs On A Schedule Yet</p>
          <p className="text-xs text-muted-foreground">
            {SCHEDULE_EMPTY_HINT}. Copy this, paste it into a thread with an agent, and it will
            appear here.
          </p>
          <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs">{SCHEDULE_EXAMPLE_REQUEST}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => copyToClipboard(SCHEDULE_EXAMPLE_REQUEST, undefined)}
          >
            {isCopied ? "Copied" : "Copy This Request"}
          </Button>
        </div>
      ) : (
        <ul className="flex max-w-4xl flex-col divide-y divide-border/60">
          {rows.map((row) => (
            <li
              key={row.key}
              data-wb-sched={row.state}
              className="flex flex-col gap-1.5 py-3 first:pt-0"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <h3 className="text-sm font-semibold">{row.title}</h3>
                <span className="flex items-center gap-1 text-xs font-medium">
                  <StateIcon state={row.state} />
                  {row.stateLabel}
                </span>
              </div>
              <p className="line-clamp-2 text-xs break-words text-foreground">{row.doing}</p>
              <p className="text-xs text-muted-foreground">
                {row.ownerLabel} · {row.cadence}
              </p>
              <dl className="grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-[repeat(3,minmax(0,auto))] sm:justify-start">
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Next Run:</dt>
                  <dd>{row.nextRun}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Last Ran:</dt>
                  <dd>{row.lastRun}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Last Result:</dt>
                  <dd className={row.lastResultFailed ? "font-semibold" : undefined}>
                    {row.lastResult}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center gap-1.5">
                {row.canPause ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    aria-label={`Pause ${row.title}`}
                    onClick={() => void act(row, "pause")}
                  >
                    Pause
                  </Button>
                ) : null}
                {row.canResume ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    aria-label={`Resume ${row.title}`}
                    onClick={() => void act(row, "resume")}
                  >
                    Resume
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || !row.canRunNow}
                  aria-label={`Run ${row.title} Now`}
                  onClick={() => void act(row, "runNow")}
                >
                  {busy === row.key ? <Spinner size="sm" /> : null}
                  Run Now
                </Button>
                {row.canOpen ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label={`Open the thread for ${row.title}`}
                    onClick={() => open(row)}
                  >
                    Open Thread
                  </Button>
                ) : null}
              </div>
              {row.readOnlyReason !== null ? (
                <p className="text-2xs text-muted-foreground">{row.readOnlyReason}</p>
              ) : null}
              {notice?.key === row.key ? (
                <Alert variant={notice.kind === "error" ? "error" : "info"}>
                  <AlertDescription>{notice.text}</AlertDescription>
                </Alert>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
