import { useState } from "react";
import {
  type CustomCodeTool,
  MAX_CUSTOM_TOOLS,
  MAX_SAVED_LAYOUTS,
  mediaLayout,
  type SavedCodeLayout,
} from "./codeLayouts";
import {
  type CodeTeam,
  describeTeam,
  MAX_SAVED_TEAMS,
  MAX_TEAM_MEMBERS,
  type SavedCodeTeam,
  type TeamMember,
} from "./codeTeams";
import { VoiceDictation } from "./VoiceDictation";
import type { CodePane } from "./workbenchStore";
import type { PaneActivity } from "./workspaceLayout";

const newMember = (): TeamMember => ({ kind: "claude", role: "", task: "" });
const newTeam = (): CodeTeam => ({ task: "", isolate: false, members: [newMember(), newMember()] });

/**
 * Starts several agents at once, each with a role and an opening task. The form
 * keeps its contents after a launch so the same team can be sent again or saved.
 */
export function CodeTeamLauncher({
  saved,
  capacity,
  disabled,
  onLaunch,
  onSave,
  onDelete,
}: {
  saved: ReadonlyArray<SavedCodeTeam>;
  /** How many more terminals the workspace can hold. */
  capacity: number;
  disabled: boolean;
  onLaunch: (team: CodeTeam) => void;
  onSave: (team: SavedCodeTeam) => void;
  onDelete: (name: string) => void;
}) {
  const [team, setTeam] = useState(newTeam);
  const [name, setName] = useState("");
  const [sentence, setSentence] = useState("");
  const [understood, setUnderstood] = useState(true);
  // Fills the form from a sentence. Nothing starts until Launch is pressed.
  const describe = (text: string) => {
    const described = describeTeam(text);
    setUnderstood(described !== null);
    if (described) setTeam(described);
  };
  const setMember = (index: number, change: Partial<TeamMember>) =>
    setTeam((current) => ({
      ...current,
      members: current.members.map((member, at) =>
        at === index ? { ...member, ...change } : member,
      ),
    }));
  const count = team.members.length;
  const replacing = saved.some((item) => item.name === name.trim());
  return (
    <details data-wb-code-menu="" data-wb-code-team="">
      <summary>Launch Team</summary>
      <div>
        {saved.map((item) => (
          <div key={item.name} data-wb-code-menu-row="">
            <span>
              <strong>{item.name}</strong> {item.members.length} agents
            </span>
            <button
              type="button"
              onClick={() => {
                const { name: savedName, ...rest } = item;
                setTeam(rest);
                setName(savedName);
              }}
            >
              Load
            </button>
            <button type="button" onClick={() => onDelete(item.name)}>
              Delete
            </button>
          </div>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            describe(sentence);
          }}
        >
          <input
            aria-label="Describe The Team"
            placeholder="Say or type: a builder and a reviewer on the login bug"
            maxLength={600}
            value={sentence}
            onChange={(event) => setSentence(event.target.value)}
          />
          <VoiceDictation
            onTranscript={(text) => {
              setSentence(text);
              describe(text);
            }}
          />
          <button type="submit" disabled={!sentence.trim()}>
            Fill In
          </button>
        </form>
        {!understood && (
          <p role="alert">
            Could not find a team in that. Try "two builders and a reviewer on the login bug".
          </p>
        )}
        <textarea
          aria-label="Task For Everyone"
          placeholder="Task for everyone. An agent's own task replaces it."
          rows={3}
          maxLength={4000}
          value={team.task}
          onChange={(event) => setTeam((current) => ({ ...current, task: event.target.value }))}
        />
        {team.members.map((member, index) => (
          // Members have no identity beyond their position in the form.
          // oxlint-disable-next-line react/no-array-index-key
          <fieldset key={index} data-wb-code-team-member="">
            <select
              aria-label={`CLI For Agent ${index + 1}`}
              value={member.kind}
              onChange={(event) =>
                setMember(index, { kind: event.target.value === "codex" ? "codex" : "claude" })
              }
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
            <input
              aria-label={`Role For Agent ${index + 1}`}
              placeholder="Role, e.g. Reviewer"
              maxLength={40}
              value={member.role}
              onChange={(event) => setMember(index, { role: event.target.value })}
            />
            <button
              type="button"
              aria-label={`Remove Agent ${index + 1}`}
              disabled={count === 1}
              onClick={() =>
                setTeam((current) => ({
                  ...current,
                  members: current.members.filter((_, at) => at !== index),
                }))
              }
            >
              Remove
            </button>
            <input
              aria-label={`Own Task For Agent ${index + 1}`}
              placeholder="Own task (optional)"
              maxLength={4000}
              value={member.task}
              onChange={(event) => setMember(index, { task: event.target.value })}
            />
          </fieldset>
        ))}
        <button
          type="button"
          disabled={count >= MAX_TEAM_MEMBERS}
          onClick={() =>
            setTeam((current) => ({ ...current, members: [...current.members, newMember()] }))
          }
        >
          Add Agent
        </button>
        <label>
          <input
            type="checkbox"
            checked={team.isolate}
            onChange={(event) =>
              setTeam((current) => ({ ...current, isolate: event.target.checked }))
            }
          />
          Separate Worktree And Branch Per Agent
        </label>
        {!team.isolate && count > 1 && (
          <p>These agents share one folder and can overwrite each other's edits.</p>
        )}
        {count > capacity && (
          <p>
            This workspace has room for {capacity} more {capacity === 1 ? "terminal" : "terminals"}.
            Close some or remove agents.
          </p>
        )}
        <button
          type="button"
          data-wb-code-team-launch=""
          disabled={disabled || count > capacity}
          onClick={(event) => {
            event.currentTarget.closest("details")!.open = false;
            onLaunch(team);
          }}
        >
          Launch {count} {count === 1 ? "Agent" : "Agents"}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            onSave({ ...team, name: name.trim() });
          }}
        >
          <input
            aria-label="Team Name"
            placeholder="Name this team"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            disabled={!name.trim() || (!replacing && saved.length >= MAX_SAVED_TEAMS)}
          >
            {replacing ? "Replace" : "Save Team"}
          </button>
        </form>
      </div>
    </details>
  );
}

export interface DashboardRow {
  id: string;
  projectId: string;
  label: string;
  workspace: string;
  activity: PaneActivity;
  status: string;
  /** How long the session has been in this state, already formatted. */
  elapsed: string;
}

/** Every session in every workspace, most urgent first. Choosing one jumps to its pane. */
export function CodeDashboard({
  rows,
  onOpen,
}: {
  rows: ReadonlyArray<DashboardRow>;
  onOpen: (row: DashboardRow) => void;
}) {
  return (
    <aside data-wb-code-dashboard="" aria-label="All Sessions">
      <h3>All Sessions</h3>
      {rows.length === 0 && <p>No sessions are open in any workspace.</p>}
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          data-attention={row.activity === "needs-you" ? "true" : undefined}
          onClick={() => onOpen(row)}
        >
          <i aria-hidden="true" data-activity={row.activity} />
          <span>
            <strong>{row.label}</strong>
            <small>{row.workspace}</small>
          </span>
          <small>
            {row.status}
            {row.elapsed && ` · ${row.elapsed}`}
          </small>
        </button>
      ))}
    </aside>
  );
}

/** Type once, send to the chosen panes. Nothing is preselected and the choice clears after sending. */
export function CodeBroadcastBar({
  panes,
  waiting,
  onSend,
}: {
  panes: readonly CodePane[];
  /** Panes waiting on a question. A broadcast line would answer it, so they are skipped. */
  waiting: ReadonlySet<string>;
  onSend: (ids: readonly string[], text: string) => void;
}) {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const targets = chosen.filter((id) => !waiting.has(id) && panes.some((pane) => pane.id === id));
  const names = panes.filter((pane) => targets.includes(pane.id)).map((pane) => pane.label);
  return (
    <form
      data-wb-code-broadcast=""
      aria-label="Broadcast To Terminals"
      onSubmit={(event) => {
        event.preventDefault();
        if (targets.length === 0 || !text.trim()) return;
        if (!confirming) {
          setConfirming(true);
          return;
        }
        onSend(targets, text);
        setConfirming(false);
        setChosen([]);
        setText("");
      }}
    >
      <fieldset>
        <legend>Send To</legend>
        {panes.map((pane) => (
          <label key={pane.id}>
            <input
              type="checkbox"
              checked={targets.includes(pane.id)}
              disabled={waiting.has(pane.id)}
              onChange={(event) => {
                setConfirming(false);
                setChosen(
                  event.target.checked
                    ? [...targets, pane.id]
                    : targets.filter((id) => id !== pane.id),
                );
              }}
            />
            {pane.label}
            {waiting.has(pane.id) ? " (waiting on you, skipped)" : ""}
          </label>
        ))}
      </fieldset>
      <input
        aria-label="Text To Send"
        placeholder="Type once, then send to the checked terminals"
        value={text}
        onChange={(event) => {
          setConfirming(false);
          setText(event.target.value);
        }}
      />
      {confirming ? (
        <>
          <span role="status">Send to {names.join(", ")}?</span>
          <button type="submit">Confirm</button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="submit" disabled={targets.length === 0 || !text.trim()}>
          Send To {targets.length}
        </button>
      )}
    </form>
  );
}

/** Launchers for any other CLI: a name and the line to run. Saved for this environment. */
export function CodeCustomTools({
  tools,
  onSave,
}: {
  tools: readonly CustomCodeTool[];
  onSave: (tools: CustomCodeTool[]) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const taken = tools.some((tool) => tool.name === name.trim());
  return (
    <details data-wb-code-menu="">
      <summary>Custom CLI</summary>
      <div>
        <p>Add any command as a pane type, such as Aider, OpenCode or Hermes.</p>
        {tools.map((tool) => (
          <div key={tool.name} data-wb-code-menu-row="">
            <span>
              <strong>{tool.name}</strong> <code>{tool.command}</code>
            </span>
            <button
              type="button"
              onClick={() => onSave(tools.filter((item) => item.name !== tool.name))}
            >
              Remove
            </button>
          </div>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !command.trim() || taken) return;
            onSave([...tools, { name: name.trim(), command: command.trim() }]);
            setName("");
            setCommand("");
          }}
        >
          <input
            aria-label="Name"
            placeholder="Name"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            aria-label="Command"
            placeholder="Command"
            maxLength={500}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
          <button
            type="submit"
            disabled={!name.trim() || !command.trim() || taken || tools.length >= MAX_CUSTOM_TOOLS}
          >
            Add
          </button>
        </form>
        {taken && <p role="alert">A launcher with this name already exists.</p>}
      </div>
    </details>
  );
}

/** Save the current arrangement under a name, or open one into an empty workspace. */
export function CodeLayoutsMenu({
  saved,
  canSave,
  canOpen,
  onSave,
  onDelete,
  onOpen,
}: {
  saved: readonly SavedCodeLayout[];
  canSave: boolean;
  canOpen: boolean;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onOpen: (layout: SavedCodeLayout) => void;
}) {
  const [name, setName] = useState("");
  const replacing = saved.some((item) => item.name === name.trim());
  return (
    <details data-wb-code-menu="">
      <summary>Layouts</summary>
      <div>
        {!canOpen && <p>Close the open terminals to open a layout. Layouts start new sessions.</p>}
        {[mediaLayout, ...saved].map((layout) => (
          <div
            key={layout === mediaLayout ? "built-in:media" : layout.name}
            data-wb-code-menu-row=""
          >
            <span>
              <strong>{layout.name}</strong>{" "}
              {layout === mediaLayout
                ? "Agent beside the HyperFrames preview"
                : `${layout.panes.length} terminals`}
            </span>
            <button type="button" disabled={!canOpen} onClick={() => onOpen(layout)}>
              Open
            </button>
            {layout !== mediaLayout && (
              <button type="button" onClick={() => onDelete(layout.name)}>
                Delete
              </button>
            )}
          </div>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || !name.trim()) return;
            onSave(name.trim());
            setName("");
          }}
        >
          <input
            aria-label="Layout Name"
            placeholder="Name this layout"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            disabled={!canSave || !name.trim() || (!replacing && saved.length >= MAX_SAVED_LAYOUTS)}
          >
            {replacing ? "Replace" : "Save Current"}
          </button>
        </form>
      </div>
    </details>
  );
}
