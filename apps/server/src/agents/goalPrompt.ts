import type { AgentCheckIn, WorkbenchAgentGoal } from "@t3tools/contracts";

/** The previous check-in is quoted to the agent, so keep a long one from swamping the turn. */
const PREVIOUS_SUMMARY_LIMIT = 1_500;

const AUTONOMY_SENTENCE: Record<WorkbenchAgentGoal["autonomy"], string> = {
  propose: "Plan and report only: change nothing, and say what you would do.",
  act_and_report: "Do the work within your normal permissions, then report what you did.",
  act_freely: "Do whatever the goal needs, then report what you did.",
};

export interface GoalPromptInput {
  readonly goal: Pick<WorkbenchAgentGoal, "id" | "title" | "outcome" | "autonomy">;
  /** The goal's most recent check-in, whether or not the owner has reviewed it. */
  readonly previous: Pick<AgentCheckIn, "summary" | "needsFromOwner" | "createdAt"> | null;
  /** The owner's latest review note on this goal. */
  readonly ownerNote: string | null;
}

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}...`;

/**
 * The text sent to the agent on every goal turn. It is stored as the scheduled task's
 * prompt and rebuilt whenever the goal or its check-ins change, so each turn starts from
 * the latest state. `propose` is enforced by this wording alone; the thread's runtime mode
 * is the real permission boundary.
 */
export function buildGoalTurnPrompt(input: GoalPromptInput): string {
  const { goal, previous, ownerNote } = input;
  const lines = [
    "This is a scheduled turn on one of your standing goals.",
    "",
    `Goal: ${goal.title}`,
    `Outcome wanted: ${goal.outcome}`,
    `How much to do: ${AUTONOMY_SENTENCE[goal.autonomy]}`,
  ];
  if (previous !== null) {
    lines.push(
      "",
      `Your previous check-in (${previous.createdAt}): ${clip(previous.summary, PREVIOUS_SUMMARY_LIMIT)}`,
    );
    if (previous.needsFromOwner !== null) {
      lines.push(
        `You asked the owner for: ${clip(previous.needsFromOwner, PREVIOUS_SUMMARY_LIMIT)}`,
      );
    }
  }
  if (ownerNote !== null) {
    lines.push("", `The owner's latest note: ${ownerNote}`);
  }
  lines.push(
    "",
    `Finish this turn by calling the report_checkin tool with goalId "${goal.id}", a short summary of what you did and found, and needsFromOwner if you need a decision or input from the owner. Set done to true only if the outcome is fully achieved. Do not end the turn without calling report_checkin.`,
  );
  return lines.join("\n");
}
