import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AgentAvatar } from "./AgentAvatar";
import { formatQuietLabel } from "@t3tools/client-runtime/work-log/run-wait";
import { checkInsWaitingLabel } from "@t3tools/client-runtime/operations/agent-check-ins";
import {
  AGENT_BOARD_NEED_LABEL,
  AGENT_BOARD_STATUS_LABEL,
  summarizeAgentBoard,
  type AgentBoardAgent,
  type AgentBoardEntry,
} from "./agentBoard";
import type { AgentProfile } from "./workbenchPreferences";

export type TeamBoardAgent = AgentBoardAgent & { readonly profile: AgentProfile };

/** Every agent's state at a glance. Entries arrive ordered and classified; this only draws them. */
export function AgentTeamBoard({
  entries,
  ready,
  busy,
  environmentLabel,
  onOpen,
}: {
  entries: ReadonlyArray<AgentBoardEntry<TeamBoardAgent>>;
  ready: boolean;
  busy: boolean;
  /** Name of the machine for an environment that is not this device. */
  environmentLabel: (environmentId: string) => string;
  onOpen: (agent: AgentProfile) => void;
}) {
  const summary = summarizeAgentBoard(entries);
  return (
    <section data-wb-board="" aria-label="Team Board">
      <h2>Team Board</h2>
      <p data-wb-board-summary="" aria-live="polite">
        {!ready
          ? "Connecting To Your Agent Workspace…"
          : entries.length === 0
            ? "No Agents Yet"
            : summary.label}
      </p>
      <ul data-wb-board-list="">
        {entries.map((entry) => {
          const { agent, status } = entry;
          const activity = entry.lastActivityAt
            ? formatRelativeTimeLabel(entry.lastActivityAt)
            : "";
          return (
            <li key={agent.id}>
              <button
                type="button"
                data-wb-board-row=""
                data-wb-board-status={status}
                disabled={busy}
                onClick={() => onOpen(agent.profile)}
              >
                <AgentAvatar agent={agent.profile} size={40} />
                <span data-wb-board-text="">
                  <strong>{agent.name}</strong>
                  <small>
                    {status === "not-started"
                      ? "No Conversation Yet"
                      : activity
                        ? `Last Activity ${activity}`
                        : "No Recent Activity"}
                    {entry.remoteEnvironmentId &&
                      ` · On ${environmentLabel(entry.remoteEnvironmentId)}`}
                  </small>
                  {entry.quietMinutes !== null && (
                    <small data-wb-board-quiet="">{formatQuietLabel(entry.quietMinutes)}</small>
                  )}
                  {entry.askedBy !== null && (
                    <small data-wb-board-asked="">Asked by {entry.askedBy}</small>
                  )}
                  {entry.waitingOn.length > 0 && (
                    <small data-wb-board-asked="">Waiting on {entry.waitingOn.join(", ")}</small>
                  )}
                  {entry.pendingCheckIns > 0 && (
                    <small data-wb-board-checkins="">
                      {checkInsWaitingLabel(entry.pendingCheckIns)}
                    </small>
                  )}
                </span>
                <span data-wb-board-badge="">
                  {AGENT_BOARD_STATUS_LABEL[status]}
                  {entry.need && <small>{AGENT_BOARD_NEED_LABEL[entry.need]}</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
