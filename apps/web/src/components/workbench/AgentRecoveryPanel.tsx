import { useState } from "react";
import type { AgentContinuation, WorkspaceAgent } from "@t3tools/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useNavigate } from "@tanstack/react-router";
import { randomUUID } from "../../lib/utils";
export function AgentRecoveryPanel({
  agent,
  save,
  prepare,
  providers,
}: {
  agent: WorkspaceAgent;
  save: (agent: WorkspaceAgent) => Promise<WorkspaceAgent>;
  prepare: (id: string) => Promise<AgentContinuation>;
  providers: readonly ProviderInstanceEntry[];
}) {
  const [tab, setTab] = useState("work");
  const [summary, setSummary] = useState(agent.recovery.summary);
  const [evidence, setEvidence] = useState(agent.recovery.evidence.join("\n"));
  const [checked, setChecked] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memory, setMemory] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [context, setContext] = useState<AgentContinuation | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-wb-agent-details="">
      <nav aria-label="Agent Details">
        {[
          ["work", "Current Work"],
          ["memory", "Memory"],
          ["connections", "Connections"],
          ["routines", "Routines"],
        ].map(([value, label]) => (
          <button key={value} aria-pressed={tab === value} onClick={() => setTab(value!)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "work" && (
        <>
          <p role="status">
            <strong>
              {agent.recovery.disposition === "ready"
                ? "Ready To Continue"
                : agent.recovery.disposition === "completed"
                  ? "Completed"
                  : agent.recovery.disposition === "continue_in_source"
                    ? "Continue In Grok Bot"
                    : "Recovery Needs Review"}
            </strong>{" "}
            ·{" "}
            {agent.archive ? `${agent.archive.messages.length} cached messages` : "Workbench Agent"}
          </p>
          <p>{agent.recovery.summary}</p>
          <p>
            Profile saved {new Date(agent.updatedAt).toLocaleString()}
            {agent.recovery.verifiedAt
              ? ` · Recovery verified ${new Date(agent.recovery.verifiedAt).toLocaleString()}`
              : " · Current work not yet verified"}
          </p>
          {agent.recovery.blockers.length > 0 && (
            <ul>
              {[...new Set(agent.recovery.blockers)].map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>Review Continuation</summary>
            <p>
              Confirm the latest source work and dependencies before moving an unfinished task.
              Original routines must remain with one owner.
            </p>
            <label>
              Work Handoff
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} />
            </label>
            <label>
              Evidence And File References
              <textarea
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="One source or file reference per line"
                rows={3}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              I verified the latest conversation, files, connections, and execution state.
            </label>
            <button
              disabled={busy || !checked || !summary.trim() || !evidence.trim()}
              onClick={() =>
                void act(() =>
                  save({
                    ...agent,
                    recovery: {
                      disposition: "ready",
                      summary,
                      blockers: [],
                      evidence: evidence.split("\n").filter(Boolean),
                      verifiedAt: new Date().toISOString(),
                    },
                  }),
                )
              }
            >
              Save Verified Handoff
            </button>
            <button
              disabled={busy || !checked || !summary.trim() || !evidence.trim()}
              onClick={() =>
                void act(() =>
                  save({
                    ...agent,
                    recovery: {
                      disposition: "completed",
                      summary,
                      blockers: [],
                      evidence: evidence.split("\n").filter(Boolean),
                      verifiedAt: new Date().toISOString(),
                    },
                    routineOwnershipVerified: false,
                  }),
                )
              }
            >
              Mark Work Completed
            </button>

            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  save({
                    ...agent,
                    recovery: { ...agent.recovery, disposition: "continue_in_source" },
                  }),
                )
              }
            >
              Keep Work In Grok Bot
            </button>
          </details>
          <button
            disabled={busy}
            onClick={() => void act(async () => setContext(await prepare(agent.profile.id)))}
          >
            Preview Context
          </button>
          {context && (
            <details open>
              <summary>
                Context Preview · {context.includedMessages} Messages Included ·{" "}
                {context.omittedMessages} In Archive
              </summary>
              <pre>{context.context}</pre>
            </details>
          )}
        </>
      )}
      {tab === "memory" && (
        <>
          <p>
            Memory follows this agent across model changes. Every entry stays editable and shows its
            origin.
          </p>
          {agent.memories.map((m) => (
            <article key={m.id}>
              <small>{m.origin === "user" ? "Your Instruction" : "Inferred Memory"}</small>
              <p>{m.text}</p>
              <small>{m.sources.join(" · ")}</small>
              <button
                disabled={busy}
                onClick={() => {
                  setEditingMemoryId(m.id);
                  setMemory(m.text);
                  setSource(m.sources.join("\n"));
                }}
              >
                Edit
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    save({ ...agent, memories: agent.memories.filter((item) => item.id !== m.id) }),
                  )
                }
              >
                Remove Memory
              </button>
            </article>
          ))}
          <label>
            Memory
            <textarea value={memory} onChange={(e) => setMemory(e.target.value)} maxLength={8000} />
          </label>
          <label>
            Source References
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Conversation or file reference"
            />
          </label>
          <button
            disabled={busy || !memory.trim()}
            onClick={() =>
              void act(async () => {
                await save({
                  ...agent,
                  memories: [
                    ...agent.memories.filter((m) => m.id !== editingMemoryId),
                    {
                      id: editingMemoryId ?? randomUUID(),
                      text: memory.trim(),
                      origin: "user",
                      sources: source.split("\n").filter(Boolean),
                    },
                  ],
                });
                setMemory("");
                setSource("");
                setEditingMemoryId(null);
              })
            }
          >
            Save Memory
          </button>
        </>
      )}
      {tab === "connections" && (
        <>
          <p>
            Accounts belong to this Workbench environment. Grok Bot connections and computer
            sessions are not transferred by an archive.
          </p>
          {providers.map((p) => (
            <article key={p.instanceId}>
              <p>
                <strong>{p.displayName}</strong> · {p.enabled ? p.status : "Disabled"} ·{" "}
                {p.models.length} models
              </p>
              <p>
                {p.snapshot.message ??
                  (p.snapshot.installed ? "Installed" : "Installation required")}
              </p>
              <details>
                <summary>Available Skills And Commands</summary>
                {p.snapshot.skills.length === 0 && p.snapshot.slashCommands.length === 0 ? (
                  <p>No capabilities reported by this account yet.</p>
                ) : (
                  <ul>
                    {p.snapshot.skills.map((skill) => (
                      <li key={`skill:${skill.name}`}>{skill.displayName ?? skill.name}</li>
                    ))}
                    {p.snapshot.slashCommands.map((command) => (
                      <li key={`command:${command.name}`}>/{command.name}</li>
                    ))}
                  </ul>
                )}
              </details>
            </article>
          ))}
          <button onClick={() => void navigate({ to: "/settings/providers" })}>
            Manage Model Accounts
          </button>
          <p>
            Verify each task’s required apps, files, and computer access in the recovery checklist
            before continuing.
          </p>
        </>
      )}
      {tab === "routines" && (
        <>
          <p>
            Grok Bot routines remain in Grok Bot. Imported history never activates a Workbench
            routine.
          </p>
          <label data-wb-checkbox="">
            <input
              type="checkbox"
              checked={agent.routineOwnershipVerified ?? false}
              disabled={busy || agent.recovery.disposition !== "ready"}
              onChange={(e) =>
                void act(() => save({ ...agent, routineOwnershipVerified: e.target.checked }))
              }
            />
            I verified that migrated routines have one owner and their connections are ready.
          </label>
          <button onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}>
            Manage Workspace Routines
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
