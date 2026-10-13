import {
  AGENT_CHECKIN_NOTE_MAX,
  type AgentCheckIn,
  type EnvironmentId,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { AgentAvatar } from "./AgentAvatar";
import { ClampedText } from "./ClampedText";
import {
  CHECKIN_STATUS_LABEL,
  applyReviewed,
  arrangeCheckIns,
  checkInsWaitingLabel,
  checkRedirectNote,
  goalTitleFor,
  type CheckInFilter,
} from "@t3tools/client-runtime/operations/agent-check-ins";
import { goalErrorMessage, goalErrorReason } from "@t3tools/client-runtime/operations/agent-goals";
import { useAllCheckIns, usePendingCheckIns } from "./useAgentCheckIns";
import type { AgentProfile } from "./workbenchPreferences";

type ReviewAction = "approve" | "redirect" | "dismiss";

const UNKNOWN_AGENT = { name: "Unknown Agent", color: "#8a8a8a" } as const;

/**
 * Everything the agents have reported on their goals. What waits for you comes first; approve it,
 * dismiss it, or redirect the agent with a note that becomes its next instruction.
 */
export function AgentCheckInInbox({
  environmentId,
  connected,
  agents,
  onOpen,
}: {
  environmentId: EnvironmentId | null;
  connected: boolean;
  /** Every agent record in the workspace, archived ones too: their old check-ins still show. */
  agents: ReadonlyArray<WorkspaceAgent>;
  onOpen: (agent: AgentProfile) => void;
}) {
  const [filter, setFilter] = useState<CheckInFilter>("waiting");
  const pending = usePendingCheckIns(environmentId, connected);
  const all = useAllCheckIns(environmentId, connected, filter === "all");
  const review = useAtomCommand(serverEnvironment.agentCheckInsReview, { reportFailure: false });
  // Reviewed here a moment ago; shown at once rather than when the server's next list arrives.
  const [reviewed, setReviewed] = useState<Readonly<Record<string, AgentCheckIn>>>({});
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const waitingCount = applyReviewed(pending.checkIns, reviewed).filter(
    (checkIn) => checkIn.status === "pending",
  ).length;
  const waitingLabel = checkInsWaitingLabel(waitingCount, pending.hasMore);
  const items = arrangeCheckIns({
    filter,
    pending: applyReviewed(pending.checkIns, reviewed),
    all: applyReviewed(all.checkIns, reviewed),
  });
  const loading = pending.loading || (filter === "all" && all.loading);
  const error = pending.error ?? (filter === "all" ? all.error : null);
  const showEmpty = environmentId !== null && connected && !loading && !error && items.length === 0;
  const retry = () => {
    pending.refresh();
    if (filter === "all") all.refresh();
  };

  const submit = async (
    checkIn: AgentCheckIn,
    action: ReviewAction,
    note?: string,
  ): Promise<boolean> => {
    if (!environmentId) return false;
    setWorking((current) => new Set(current).add(checkIn.id));
    setErrors(({ [checkIn.id]: _cleared, ...rest }) => rest);
    const result = await review({
      environmentId,
      input: { id: checkIn.id, action, ...(note ? { note } : {}) },
    });
    setWorking((current) => {
      const next = new Set(current);
      next.delete(checkIn.id);
      return next;
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const failure = squashAtomCommandFailure(result);
      if (goalErrorReason(failure) === "already_reviewed") {
        // Someone else got there first. Reload and let the list show the outcome.
        retry();
        return false;
      }
      setErrors((current) => ({ ...current, [checkIn.id]: goalErrorMessage(failure) }));
      return false;
    }
    setReviewed((current) => ({ ...current, [checkIn.id]: result.value }));
    return true;
  };

  return (
    <section data-wb-checkins="" aria-label="Check-Ins">
      <h2>Check-Ins</h2>
      <p data-wb-board-summary="" aria-live="polite">
        {!environmentId || !connected
          ? "Connect To Your Agent Workspace To See Check-Ins"
          : loading && !pending.loaded
            ? "Loading Check-Ins…"
            : waitingCount === 0
              ? "Nothing Waiting"
              : waitingLabel}
      </p>
      <div data-wb-checkins-filter="" role="group" aria-label="Show">
        <button
          type="button"
          aria-pressed={filter === "waiting"}
          onClick={() => setFilter("waiting")}
        >
          Waiting
        </button>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All
        </button>
      </div>
      {error && (
        <div role="alert" data-wb-error="">
          Could not load check-ins. {error}{" "}
          <button type="button" onClick={retry}>
            Try Again
          </button>
        </div>
      )}
      {showEmpty && (
        <div data-wb-goals-empty="">
          <strong>{filter === "waiting" ? "Nothing Waiting" : "No Check-Ins Yet"}</strong>
          <p>
            {filter === "waiting"
              ? "Every check-in has been reviewed."
              : "When an agent finishes a turn on one of its goals, its report lands here."}
          </p>
        </div>
      )}
      {items.length > 0 && (
        <ul data-wb-checkin-list="">
          {items.map((checkIn) => (
            <CheckInCard
              key={checkIn.id}
              checkIn={checkIn}
              agent={agents.find((entry) => entry.profile.id === checkIn.agentId)}
              goalTitle={goalTitleFor(agents, checkIn)}
              working={working.has(checkIn.id)}
              error={errors[checkIn.id] ?? null}
              onReview={(action, note) => submit(checkIn, action, note)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckInCard({
  checkIn,
  agent,
  goalTitle,
  working,
  error,
  onReview,
  onOpen,
}: {
  checkIn: AgentCheckIn;
  agent: WorkspaceAgent | undefined;
  goalTitle: string | null;
  working: boolean;
  error: string | null;
  onReview: (action: ReviewAction, note?: string) => Promise<boolean>;
  onOpen: (agent: AgentProfile) => void;
}) {
  const noteId = useId();
  const [redirecting, setRedirecting] = useState(false);
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const waiting = checkIn.status === "pending";
  const profile = agent?.profile ?? UNKNOWN_AGENT;
  const reviewedAgo = checkIn.reviewedAt ? formatRelativeTimeLabel(checkIn.reviewedAt) : "";
  return (
    <li data-wb-checkin="" data-wb-checkin-status={checkIn.status}>
      <header data-wb-checkin-head="">
        <AgentAvatar agent={profile} size={36} />
        <div data-wb-checkin-who="">
          <strong>{profile.name}</strong>
          <small>
            {goalTitle ?? "Deleted Goal"} · {formatRelativeTimeLabel(checkIn.createdAt)}
          </small>
        </div>
        <span data-wb-checkin-state="">
          {CHECKIN_STATUS_LABEL[checkIn.status]}
          {!waiting && reviewedAgo && <small>{reviewedAgo}</small>}
        </span>
      </header>
      <ClampedText text={checkIn.summary} />
      {checkIn.needsFromOwner && (
        <div data-wb-checkin-needs="">
          <strong>Needs From You</strong>
          <ClampedText text={checkIn.needsFromOwner} lines={4} />
        </div>
      )}
      {checkIn.source === "fallback" && (
        <small data-wb-checkin-note="">
          Written By The Server. The agent filed no report of its own, so this quotes its last
          reply.
        </small>
      )}
      {!waiting && checkIn.ownerNote && (
        <div data-wb-checkin-owner-note="">
          <strong>Your Note</strong>
          <ClampedText text={checkIn.ownerNote} lines={4} />
        </div>
      )}
      {waiting && (
        <div data-wb-checkin-actions="">
          <button
            type="button"
            data-wb-primary=""
            disabled={working}
            onClick={() => void onReview("approve")}
          >
            Approve
          </button>
          <button type="button" disabled={working} onClick={() => void onReview("dismiss")}>
            Dismiss
          </button>
          <button
            type="button"
            disabled={working}
            aria-expanded={redirecting}
            aria-controls={noteId}
            onClick={() => setRedirecting((open) => !open)}
          >
            Redirect
          </button>
          {agent && !agent.archivedAt && (
            <button type="button" onClick={() => onOpen(agent.profile)}>
              Open Conversation
            </button>
          )}
          {working && <small role="status">Saving…</small>}
        </div>
      )}
      {!waiting && agent && !agent.archivedAt && (
        <div data-wb-checkin-actions="">
          <button type="button" onClick={() => onOpen(agent.profile)}>
            Open Conversation
          </button>
        </div>
      )}
      {waiting && redirecting && (
        <form
          id={noteId}
          data-wb-checkin-redirect=""
          onSubmit={async (event) => {
            event.preventDefault();
            const checked = checkRedirectNote(note);
            setNoteMissing(!checked.ok);
            if (!checked.ok) return;
            if (await onReview("redirect", checked.note)) {
              setRedirecting(false);
              setNote("");
            }
          }}
        >
          <label>
            Note For The Agent
            <textarea
              autoFocus
              rows={3}
              maxLength={AGENT_CHECKIN_NOTE_MAX}
              aria-invalid={noteMissing}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setNoteMissing(false);
              }}
            />
          </label>
          <small>This note is sent to the agent as its next instruction.</small>
          {noteMissing && (
            <p role="alert" data-wb-error="">
              Write a note first. It is the instruction the agent will follow.
            </p>
          )}
          <div data-wb-actions="">
            <button type="submit" data-wb-primary="" disabled={working}>
              Send Redirect
            </button>
            <button type="button" disabled={working} onClick={() => setRedirecting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" data-wb-error="">
          {error}
        </p>
      )}
    </li>
  );
}
