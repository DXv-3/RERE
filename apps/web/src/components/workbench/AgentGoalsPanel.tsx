import {
  AGENT_GOAL_MAX_COUNT,
  type EnvironmentId,
  type WorkbenchAgentGoal,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScheduleFields } from "../settings/ScheduleFields";
import { ClampedText } from "./ClampedText";
import {
  AGENT_GOAL_AUTONOMY,
  autonomyLabel,
  describeSchedule,
  goalErrorMessage,
  goalReasonMessage,
  goalStatusLabel,
} from "@t3tools/client-runtime/operations/agent-goals";
import { EMPTY_GOAL_DRAFT, goalDraftToFields, goalToDraft, type GoalDraft } from "./agentGoals";

type Notice = { readonly scope: "form" | string; readonly message: string };

/**
 * An agent's standing goals: what it should keep working toward, how often it checks in, and how
 * freely it may act. Every call returns the saved agent; `onAgentChange` hands it up so the next
 * ordinary agent save carries the new revision.
 */
export function AgentGoalsPanel({
  environmentId,
  agent,
  connected,
  onAgentChange,
  onReviewCheckIns,
}: {
  environmentId: EnvironmentId;
  agent: WorkspaceAgent;
  connected: boolean;
  onAgentChange: (agent: WorkspaceAgent, environmentId: EnvironmentId) => void;
  onReviewCheckIns: () => void;
}) {
  const agentId = agent.profile.id;
  const goals = agent.goals ?? [];
  const upsert = useAtomCommand(serverEnvironment.agentGoalsUpsert, { reportFailure: false });
  const setStatus = useAtomCommand(serverEnvironment.agentGoalsSetStatus, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.agentGoalsDelete, { reportFailure: false });
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  // The call in flight, as "form" or the goal it acts on. One at a time keeps revisions in order.
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const run = async (
    scope: string,
    call: () => Promise<AtomCommandResult<{ readonly agent: WorkspaceAgent }, unknown>>,
  ) => {
    setBusy(scope);
    setNotice(null);
    const result = await call();
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setNotice({ scope, message: goalErrorMessage(squashAtomCommandFailure(result)) });
      return false;
    }
    onAgentChange(result.value.agent, environmentId);
    return true;
  };

  const save = async () => {
    if (!draft || busy) return;
    const parsed = goalDraftToFields(draft);
    if (!parsed.ok) {
      setNotice({ scope: "form", message: parsed.message });
      return;
    }
    const saved = await run("form", () =>
      upsert({
        environmentId,
        input: { agentId, ...(draft.goalId ? { goalId: draft.goalId } : {}), ...parsed.fields },
      }),
    );
    if (saved) setDraft(null);
  };

  const changeStatus = (goal: WorkbenchAgentGoal, status: WorkbenchAgentGoal["status"]) =>
    run(goal.id, () => setStatus({ environmentId, input: { agentId, goalId: goal.id, status } }));

  const deleteGoal = async (goal: WorkbenchAgentGoal) => {
    if (!window.confirm(`Delete the goal "${goal.title}"? Its past check-ins are kept.`)) return;
    const deleted = await run(goal.id, () =>
      remove({ environmentId, input: { agentId, goalId: goal.id } }),
    );
    if (deleted && draft?.goalId === goal.id) setDraft(null);
  };

  const needsConversation = agent.primaryThreadId === null;
  const atLimit = goals.length >= AGENT_GOAL_MAX_COUNT;
  const locked = !connected || busy !== null;
  return (
    <section data-wb-goals="" aria-label="Goals">
      <div data-wb-goals-heading="">
        <h3>Goals</h3>
        {!draft && (
          <button
            type="button"
            disabled={locked || needsConversation || atLimit}
            onClick={() => {
              setNotice(null);
              setDraft(EMPTY_GOAL_DRAFT);
            }}
          >
            Add Goal
          </button>
        )}
      </div>
      <p>
        A goal is something this agent keeps working toward. On its schedule the agent takes a turn
        and files a check-in for you to review.
      </p>
      {!connected && <p role="status">Reconnect to this environment to change goals.</p>}
      {needsConversation && (
        <p role="status">Start a conversation with this agent before giving it a goal.</p>
      )}
      {atLimit && !draft && <p role="status">{goalReasonMessage("goal_limit")}</p>}
      {draft && (
        <GoalForm
          draft={draft}
          onChange={(patch) =>
            setDraft((current) => (current ? { ...current, ...patch } : current))
          }
          saving={busy === "form"}
          disabled={locked}
          error={notice?.scope === "form" ? notice.message : null}
          onSubmit={() => void save()}
          onCancel={() => {
            setNotice(null);
            setDraft(null);
          }}
        />
      )}
      {goals.length === 0 ? (
        !draft && (
          <div data-wb-goals-empty="">
            <strong>No Goals Yet</strong>
            <p>Add one to give this agent something to work on while you are away.</p>
          </div>
        )
      ) : (
        <ul data-wb-goal-list="">
          {goals.map((goal) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              working={busy === goal.id}
              disabled={locked}
              error={notice?.scope === goal.id ? notice.message : null}
              onEdit={() => {
                setNotice(null);
                setDraft(goalToDraft(goal));
              }}
              onStatus={(status) => void changeStatus(goal, status)}
              onDelete={() => void deleteGoal(goal)}
              onReviewCheckIns={onReviewCheckIns}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function GoalRow({
  goal,
  working,
  disabled,
  error,
  onEdit,
  onStatus,
  onDelete,
  onReviewCheckIns,
}: {
  goal: WorkbenchAgentGoal;
  working: boolean;
  disabled: boolean;
  error: string | null;
  onEdit: () => void;
  onStatus: (status: WorkbenchAgentGoal["status"]) => void;
  onDelete: () => void;
  onReviewCheckIns: () => void;
}) {
  const titleId = useId();
  const stoppedByServer = goal.status === "paused" && goal.pausedReason === "unreviewed_limit";
  return (
    <li data-wb-goal="" data-wb-goal-status={goal.status}>
      <div data-wb-goal-head="">
        <strong id={titleId}>{goal.title}</strong>
        <span data-wb-goal-state="">{goalStatusLabel(goal)}</span>
      </div>
      <ClampedText text={goal.outcome} lines={3} />
      <small data-wb-goal-meta="">
        {describeSchedule(goal.schedule)} · {autonomyLabel(goal.autonomy)}
      </small>
      {stoppedByServer && (
        <small data-wb-goal-meta="">
          Review the waiting check-ins, then resume. It will pause again if they pile up.
        </small>
      )}
      <div data-wb-goal-actions="">
        {goal.status === "active" && (
          <button
            type="button"
            disabled={disabled}
            aria-describedby={titleId}
            onClick={() => onStatus("paused")}
          >
            Pause
          </button>
        )}
        {goal.status === "paused" && (
          <button
            type="button"
            disabled={disabled}
            aria-describedby={titleId}
            onClick={() => onStatus("active")}
          >
            Resume
          </button>
        )}
        {goal.status !== "done" ? (
          <button
            type="button"
            disabled={disabled}
            aria-describedby={titleId}
            onClick={() => onStatus("done")}
          >
            Mark Done
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled}
            aria-describedby={titleId}
            onClick={() => onStatus("active")}
          >
            Reopen
          </button>
        )}
        {stoppedByServer && (
          <button type="button" aria-describedby={titleId} onClick={onReviewCheckIns}>
            Review Check-Ins
          </button>
        )}
        <button type="button" disabled={disabled} aria-describedby={titleId} onClick={onEdit}>
          Edit
        </button>
        <button type="button" disabled={disabled} aria-describedby={titleId} onClick={onDelete}>
          Delete
        </button>
      </div>
      {working && (
        <small role="status" data-wb-goal-meta="">
          Saving…
        </small>
      )}
      {error && (
        <p role="alert" data-wb-error="">
          {error}
        </p>
      )}
    </li>
  );
}

function GoalForm({
  draft,
  onChange,
  saving,
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  draft: GoalDraft;
  onChange: (patch: Partial<GoalDraft>) => void;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  return (
    <form
      data-wb-goal-form=""
      aria-label={draft.goalId ? "Edit Goal" : "New Goal"}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h4>{draft.goalId ? "Edit Goal" : "New Goal"}</h4>
      <label>
        Title
        <input
          autoFocus
          required
          maxLength={200}
          placeholder="Keep the support inbox under control"
          value={draft.title}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>
      <label>
        Outcome
        <textarea
          required
          rows={4}
          maxLength={4000}
          placeholder="What done looks like, in plain words."
          value={draft.outcome}
          onChange={(event) => onChange({ outcome: event.target.value })}
        />
      </label>
      <div data-wb-goal-schedule="">
        <ScheduleFields idPrefix={`goal-${id}`} value={draft} onChange={onChange} />
      </div>
      <fieldset>
        <legend>Autonomy</legend>
        {AGENT_GOAL_AUTONOMY.map((option) => (
          <label key={option.value} data-wb-radio="">
            <input
              type="radio"
              name={`autonomy-${id}`}
              value={option.value}
              checked={draft.autonomy === option.value}
              onChange={() => onChange({ autonomy: option.value })}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.help}</small>
            </span>
          </label>
        ))}
        <small>The agent’s Permissions setting still decides what it is able to touch.</small>
      </fieldset>
      {error && (
        <p role="alert" data-wb-error="">
          {error}
        </p>
      )}
      <div data-wb-actions="">
        <button type="submit" data-wb-primary="" disabled={disabled}>
          {saving ? "Saving…" : "Save Goal"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
