import { useWorkbenchStore } from "./workbenchStore";
import { useWorkbenchPreferences } from "./workbenchPreferences";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GrokBotHistory } from "./GrokBotMigration";
import { AgentAvatar } from "./AgentAvatar";
import { AGENTS_CHANGED_EVENT } from "./useAgentWorkspace";
import { useThreadAgent } from "./useThreadAgent";
export function AgentThreadHistory({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const agent = useThreadAgent(environmentId, threadId);
  const save = useAtomCommand(serverEnvironment.agentsSave, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  if (!agent) return null;
  const needsReview =
    agent.recovery.disposition !== "ready" &&
    agent.recovery.disposition !== "completed" &&
    !agent.archivedAt;
  // The user vouching here is the evidence. Scheduled routines stay with their
  // original owner until that is confirmed separately in Agent Settings.
  const confirmResume = async () => {
    setSaving(true);
    setResumeError(null);
    const verifiedAt = new Date().toISOString();
    const result = await save({
      environmentId,
      input: {
        agent: {
          ...agent,
          recovery: {
            ...agent.recovery,
            disposition: "ready",
            blockers: [],
            verifiedAt,
            evidence: [
              ...agent.recovery.evidence,
              `Confirmed in the thread on ${verifiedAt}: latest source conversation, files, tools and running routines checked.`,
            ].slice(-100),
          },
        },
        expectedRevision: agent.revision,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setConfirming(false);
      window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
    } else {
      setResumeError(
        "Could not save. Open Agent Settings to review this agent, or try again in a moment.",
      );
    }
  };
  return (
    <div className="chat-content-lane" data-wb-agent-timeline="">
      <header>
        <AgentAvatar agent={agent.profile} size={42} />
        <strong>{agent.profile.name}</strong>
        <button
          onClick={() => {
            // The agent was found in this thread's environment, so open the tab there.
            useWorkbenchPreferences.getState().selectAgentEnvironment(environmentId);
            useWorkbenchPreferences.getState().selectAgent(agent.profile.id);
            useWorkbenchStore.getState().setAgentView("details");
            useWorkbenchStore.getState().setMode("agent");
          }}
        >
          Agent Settings
        </button>
      </header>
      <p>{agent.recovery.summary}</p>
      {needsReview && (
        <section data-wb-agent-resume="" aria-label="Resume This Agent">
          <strong>Messages are paused for this agent</strong>
          <p>
            It was imported from Grok Bot, so CodeWrench cannot tell whether this copy is its latest
            work. Confirm you have checked, and it continues here with its history and memory.
          </p>
          {agent.recovery.blockers.length > 0 && (
            <ul>
              {[...new Set(agent.recovery.blockers)].map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {confirming ? (
            <div>
              <button disabled={saving} onClick={() => void confirmResume()}>
                {saving ? "Saving…" : "I Checked, Resume Here"}
              </button>
              <button disabled={saving} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)}>Confirm And Resume Here</button>
          )}
          {resumeError && <p role="alert">{resumeError}</p>}
        </section>
      )}
      {agent.archive && (
        <GrokBotHistory
          agentId={agent.profile.id}
          serverArchive={agent.archive}
          initiallyExpanded
        />
      )}
      <p data-wb-continuation-boundary="">
        Workbench Conversation ·{" "}
        {agent.recovery.disposition === "ready"
          ? "Verified handoff and agent memory accompany your new messages."
          : "Confirm above before resuming imported work."}
      </p>
    </div>
  );
}
