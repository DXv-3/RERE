import {
  AGENT_GOAL_AUTONOMY,
  autonomyLabel,
  describeSchedule,
  goalErrorMessage,
  goalReasonMessage,
  goalStatusLabel,
} from "@t3tools/client-runtime/operations/agent-goals";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_GOAL_MAX_COUNT,
  type EnvironmentId,
  type WorkbenchAgentGoal,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  EMPTY_GOAL_DRAFT,
  goalDraftToFields,
  goalToDraft,
  type AgentEntry,
  type GoalDraft,
} from "./agentGoalsLogic";
import { ActionButton } from "./components/ActionButton";
import { ClampedText } from "./components/ClampedText";
import {
  FormField,
  ScheduleFields,
  SCHEDULE_TIME_ZONE_NOTE,
  SelectRow,
} from "./components/ScheduleFields";
import { SettingsSection } from "./components/SettingsSection";

type Notice = { readonly scope: "form" | string; readonly message: string };

/**
 * An agent's standing goals: what it keeps working toward, how often it checks in, and how freely
 * it may act. Every call returns the saved agent; `onAgentChange` hands it up so the next ordinary
 * agent save carries the new revision.
 */
export function AgentGoalsSection(props: {
  readonly entry: AgentEntry;
  readonly connected: boolean;
  /** The screen is saving something else; goal calls wait so revisions stay in order. */
  readonly locked: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onAgentChange: (agent: WorkspaceAgent, environmentId: EnvironmentId) => void;
  readonly onReviewCheckIns: () => void;
}) {
  const { environmentId, agent } = props.entry;
  const agentId = agent.profile.id;
  const goals = agent.goals ?? [];
  const upsert = useAtomCommand(serverEnvironment.agentGoalsUpsert, { reportFailure: false });
  const setStatus = useAtomCommand(serverEnvironment.agentGoalsSetStatus, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.agentGoalsDelete, { reportFailure: false });
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  // The call in flight, as "form" or the goal it acts on.
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const run = async (
    scope: string,
    call: () => Promise<AtomCommandResult<{ readonly agent: WorkspaceAgent }, unknown>>,
  ) => {
    setWorking(scope);
    props.onBusyChange(true);
    setNotice(null);
    try {
      const result = await call();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          setNotice({ scope, message: goalErrorMessage(squashAtomCommandFailure(result)) });
        return false;
      }
      props.onAgentChange(result.value.agent, environmentId);
      return true;
    } finally {
      setWorking(null);
      props.onBusyChange(false);
    }
  };

  const save = async () => {
    if (!draft || disabled) return;
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

  const changeStatus = (goal: WorkbenchAgentGoal, status: WorkbenchAgentGoal["status"]) => {
    if (disabled) return;
    void run(goal.id, () =>
      setStatus({ environmentId, input: { agentId, goalId: goal.id, status } }),
    );
  };

  const confirmDelete = (goal: WorkbenchAgentGoal) => {
    if (disabled) return;
    Alert.alert("Delete Goal?", `"${goal.title}". Its past check-ins are kept.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void run(goal.id, () =>
            remove({ environmentId, input: { agentId, goalId: goal.id } }),
          ).then((deleted) => {
            if (deleted) setDraft((current) => (current?.goalId === goal.id ? null : current));
          });
        },
      },
    ]);
  };

  const needsConversation = agent.primaryThreadId === null;
  const atLimit = goals.length >= AGENT_GOAL_MAX_COUNT;
  const disabled = !props.connected || props.locked || working !== null;
  return (
    <View className="gap-3">
      <SettingsSection
        title="Goals"
        trailing={
          draft ? undefined : (
            <ActionButton
              label="Add Goal"
              accessibilityLabel={`Add a goal for ${agent.profile.name}`}
              tone="primary"
              disabled={disabled || needsConversation || atLimit || !!agent.archivedAt}
              onPress={() => {
                setNotice(null);
                setDraft(EMPTY_GOAL_DRAFT);
              }}
            />
          )
        }
      >
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            A goal is something this agent keeps working toward. On its schedule the agent takes a
            turn and files a check-in for you to review.
          </Text>
          {!props.connected ? (
            <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
              Reconnect to this environment to change goals.
            </Text>
          ) : null}
          {needsConversation ? (
            <Text className="text-sm text-foreground-muted">
              Start a conversation with this agent before giving it a goal.
            </Text>
          ) : null}
          {atLimit && !draft ? (
            <Text className="text-sm text-foreground-muted">{goalReasonMessage("goal_limit")}</Text>
          ) : null}
        </View>
      </SettingsSection>

      {draft ? (
        <GoalForm
          draft={draft}
          saving={working === "form"}
          disabled={disabled}
          error={notice?.scope === "form" ? notice.message : null}
          onChange={(patch) =>
            setDraft((current) => (current ? { ...current, ...patch } : current))
          }
          onSubmit={() => void save()}
          onCancel={() => {
            setNotice(null);
            setDraft(null);
          }}
        />
      ) : null}

      <SettingsSection>
        {goals.length === 0 ? (
          <View className="gap-1 px-4 py-4">
            <Text className="text-base font-t3-medium text-foreground">No Goals Yet</Text>
            <Text className="text-sm text-foreground-muted">
              Add one to give this agent something to work on while you are away.
            </Text>
          </View>
        ) : (
          goals.map((goal, index) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              first={index === 0}
              working={working === goal.id}
              disabled={disabled}
              error={notice?.scope === goal.id ? notice.message : null}
              onEdit={() => {
                setNotice(null);
                setDraft(goalToDraft(goal));
              }}
              onStatus={(status) => changeStatus(goal, status)}
              onDelete={() => confirmDelete(goal)}
              onReviewCheckIns={props.onReviewCheckIns}
            />
          ))
        )}
      </SettingsSection>
    </View>
  );
}

function GoalRow(props: {
  readonly goal: WorkbenchAgentGoal;
  readonly first: boolean;
  readonly working: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onEdit: () => void;
  readonly onStatus: (status: WorkbenchAgentGoal["status"]) => void;
  readonly onDelete: () => void;
  readonly onReviewCheckIns: () => void;
}) {
  const { goal, disabled } = props;
  const stoppedByServer = goal.status === "paused" && goal.pausedReason === "unreviewed_limit";
  const named = (action: string) => `${action} ${goal.title}`;
  return (
    <View
      className={props.first ? "gap-2 px-4 py-4" : "gap-2 border-t border-border-subtle px-4 py-4"}
    >
      <Text className="text-lg font-t3-medium text-foreground">{goal.title}</Text>
      <Text
        className={
          stoppedByServer
            ? "text-sm font-t3-medium text-danger-foreground"
            : "text-sm font-t3-medium text-foreground-muted"
        }
      >
        {goalStatusLabel(goal)}
      </Text>
      <ClampedText text={goal.outcome} lines={3} />
      <Text className="text-sm text-foreground-muted">
        {describeSchedule(goal.schedule)} · {autonomyLabel(goal.autonomy)}
      </Text>
      {stoppedByServer ? (
        <Text className="text-sm text-foreground-muted">
          Review the waiting check-ins, then resume. It will pause again if they pile up.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2 pt-1">
        {goal.status === "active" ? (
          <ActionButton
            label="Pause"
            accessibilityLabel={named("Pause")}
            disabled={disabled}
            onPress={() => props.onStatus("paused")}
          />
        ) : null}
        {goal.status === "paused" ? (
          <ActionButton
            label="Resume"
            accessibilityLabel={named("Resume")}
            disabled={disabled}
            onPress={() => props.onStatus("active")}
          />
        ) : null}
        {goal.status !== "done" ? (
          <ActionButton
            label="Mark Done"
            accessibilityLabel={named("Mark done")}
            disabled={disabled}
            onPress={() => props.onStatus("done")}
          />
        ) : (
          <ActionButton
            label="Reopen"
            accessibilityLabel={named("Reopen")}
            disabled={disabled}
            onPress={() => props.onStatus("active")}
          />
        )}
        {stoppedByServer ? (
          <ActionButton
            label="Review Check-Ins"
            accessibilityLabel={named("Review check-ins for")}
            tone="primary"
            onPress={props.onReviewCheckIns}
          />
        ) : null}
        <ActionButton
          label="Edit"
          accessibilityLabel={named("Edit")}
          disabled={disabled}
          onPress={props.onEdit}
        />
        <ActionButton
          label="Delete"
          accessibilityLabel={named("Delete")}
          tone="danger"
          disabled={disabled}
          onPress={props.onDelete}
        />
      </View>
      {props.working ? <Text className="text-sm text-foreground-muted">Saving…</Text> : null}
      {props.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}

function GoalForm(props: {
  readonly draft: GoalDraft;
  readonly saving: boolean;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onChange: (patch: Partial<GoalDraft>) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const { draft } = props;
  const autonomy = AGENT_GOAL_AUTONOMY.find((option) => option.value === draft.autonomy);
  return (
    <View className="gap-3">
      <SettingsSection title={draft.goalId ? "Edit Goal" : "New Goal"}>
        <FormField
          label="Title"
          value={draft.title}
          disabled={props.disabled}
          maxLength={200}
          placeholder="Keep the support inbox under control"
          onChange={(title) => props.onChange({ title })}
        />
        <FormField
          label="Outcome"
          value={draft.outcome}
          disabled={props.disabled}
          multiline
          maxLength={4000}
          placeholder="What done looks like, in plain words."
          borderTop
          onChange={(outcome) => props.onChange({ outcome })}
        />
        <SelectRow
          label="Autonomy"
          value={autonomy?.label ?? draft.autonomy}
          borderTop
          actions={
            props.disabled
              ? []
              : AGENT_GOAL_AUTONOMY.map((option) => ({
                  id: option.value,
                  title: option.label,
                  subtitle: option.help,
                  state: option.value === draft.autonomy ? ("on" as const) : undefined,
                }))
          }
          onSelect={(id) => {
            const next = AGENT_GOAL_AUTONOMY.find((option) => option.value === id);
            if (next) props.onChange({ autonomy: next.value });
          }}
        />
      </SettingsSection>
      {autonomy ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {autonomy.help} The agent’s Permissions setting still decides what it is able to touch.
        </Text>
      ) : null}
      <SettingsSection title="Schedule">
        <ScheduleFields
          schedule={draft.schedule}
          disabled={props.disabled}
          onChange={(schedule) => props.onChange({ schedule })}
        />
      </SettingsSection>
      {draft.schedule.mode === "fixed_time" ? (
        <Text className="px-2 text-sm text-foreground-muted">{SCHEDULE_TIME_ZONE_NOTE}</Text>
      ) : null}
      {props.error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <ActionButton
          label={props.saving ? "Saving…" : "Save Goal"}
          tone="primary"
          disabled={props.disabled}
          onPress={props.onSubmit}
        />
        <ActionButton label="Cancel" disabled={props.saving} onPress={props.onCancel} />
      </View>
    </View>
  );
}
