import type { AgentGoalAutonomy, WorkbenchAgentGoal } from "@t3tools/contracts";
import { checkGoalFields, type GoalFields } from "@t3tools/client-runtime/operations/agent-goals";

import {
  DEFAULT_SCHEDULE_DRAFT,
  scheduleFromDraft,
  scheduleToDraft,
  type ScheduleDraft,
} from "../settings/scheduledTasksSettings.logic";

export interface GoalDraft extends ScheduleDraft {
  /** Null while creating. */
  readonly goalId: string | null;
  readonly title: string;
  readonly outcome: string;
  readonly autonomy: AgentGoalAutonomy;
}

export const EMPTY_GOAL_DRAFT: GoalDraft = {
  goalId: null,
  title: "",
  outcome: "",
  autonomy: "propose",
  ...DEFAULT_SCHEDULE_DRAFT,
};

export function goalToDraft(goal: WorkbenchAgentGoal): GoalDraft {
  return {
    goalId: goal.id,
    title: goal.title,
    outcome: goal.outcome,
    autonomy: goal.autonomy,
    ...scheduleToDraft(goal.schedule),
  };
}

/** The form as the server accepts it. The checks themselves are shared with the phone. */
export function goalDraftToFields(draft: GoalDraft): GoalFields {
  return checkGoalFields({
    title: draft.title,
    outcome: draft.outcome,
    schedule: scheduleFromDraft(draft),
    autonomy: draft.autonomy,
  });
}
