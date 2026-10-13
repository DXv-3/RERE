import {
  AGENT_SECRET_MAX_PER_AGENT,
  type AgentSecretKind,
  type AgentSecretSummary,
  type EnvironmentId,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import {
  AGENT_SECRET_KIND_OPTIONS,
  checkSecretDraft,
  describeAllowedOrigins,
  lastUsedLabel,
  parseAllowedOrigins,
  secretErrorMessage,
  secretKindLabel,
  secretValueProblem,
} from "@t3tools/client-runtime/operations/agent-secrets";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { secretRequestKey, useSecretPromptStore } from "./secretPromptStore";
import { usePendingSecretRequests, useAgentSecretList } from "./useAgentSecrets";

interface Draft {
  /** Set when replacing the value of an existing secret; the name is then fixed. */
  readonly existing: AgentSecretSummary | null;
  readonly name: string;
  readonly label: string;
  readonly kind: AgentSecretKind;
  /** Sites the secret may be typed on, as typed into the form; empty means any site. */
  readonly sites: string;
}

const EMPTY_DRAFT: Draft = { existing: null, name: "", label: "", kind: "api_key", sites: "" };

type Notice = { readonly scope: "form" | string; readonly message: string };

/**
 * The secrets this agent holds, by name, label and kind. The list does not show values: the owner can add
 * one, replace one or delete one, and the form that takes a value forgets it as soon as it is sent.
 */
export function AgentSecretsPanel({
  environmentId,
  agent,
  connected,
}: {
  environmentId: EnvironmentId;
  agent: WorkspaceAgent;
  connected: boolean;
}) {
  const agentId = agent.profile.id;
  const requests = usePendingSecretRequests(environmentId, connected);
  const { secrets, loaded, failed, reload } = useAgentSecretList(
    environmentId,
    agentId,
    connected,
    requests.updatedAt,
  );
  const waiting = requests.requests.filter((request) => request.agentId === agentId);
  const reopen = useSecretPromptStore((state) => state.reopen);
  const set = useAtomCommand(serverEnvironment.agentSecretsSet, {
    reportFailure: false,
    reportDefect: false,
  });
  const remove = useAtomCommand(serverEnvironment.agentSecretsDelete, { reportFailure: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const run = async (scope: string, call: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(scope);
    setNotice(null);
    const result = await call();
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setNotice({ scope, message: secretErrorMessage(squashAtomCommandFailure(result)) });
      return false;
    }
    reload();
    return true;
  };

  const atLimit = secrets.length >= AGENT_SECRET_MAX_PER_AGENT;
  const archived = Boolean(agent.archivedAt);
  const locked = !connected || busy !== null;
  return (
    <section data-wb-secrets="" aria-label="Secrets">
      <div data-wb-secrets-heading="">
        <h3>Secrets</h3>
        {!draft && (
          <button
            type="button"
            disabled={locked || atLimit}
            onClick={() => {
              setNotice(null);
              setDraft(EMPTY_DRAFT);
            }}
          >
            Add Secret
          </button>
        )}
      </div>
      <p>
        Keys and passwords this agent may use. It can type them into a page or read them from a
        file. They are kept out of conversations and logs, but an agent that can run commands on
        this machine could still read them.
      </p>
      {!connected && <p role="status">Reconnect to this environment to change secrets.</p>}
      {archived && <p role="status">This agent is archived, so it cannot use its secrets.</p>}
      {waiting.length > 0 && (
        <div data-wb-secrets-waiting="" role="status">
          <span>
            {waiting.length === 1
              ? "1 Request Waiting For You"
              : `${waiting.length} Requests Waiting For You`}
          </span>
          <button
            type="button"
            onClick={() =>
              reopen(waiting.map((request) => secretRequestKey(environmentId, request.id)))
            }
          >
            Answer
          </button>
        </div>
      )}
      {failed && (
        <p role="alert" data-wb-error="">
          The secrets could not be loaded. Try again.
        </p>
      )}
      {draft && (
        <SecretForm
          draft={draft}
          saving={busy === "form"}
          disabled={locked}
          error={notice?.scope === "form" ? notice.message : null}
          onCancel={() => {
            setNotice(null);
            setDraft(null);
          }}
          onSubmit={async (fields) => {
            const saved = await run("form", () =>
              set({
                environmentId,
                input: {
                  agentId,
                  name: fields.name,
                  label: fields.label,
                  kind: fields.kind,
                  allowedOrigins: fields.allowedOrigins,
                  value: Redacted.make(fields.value),
                },
              }),
            );
            if (saved) setDraft(null);
            return saved;
          }}
        />
      )}
      {secrets.length === 0 ? (
        !draft &&
        loaded && (
          <div data-wb-secrets-empty="">
            <strong>No Secrets Yet</strong>
            <p>Add one here, or the agent can ask you for one when it needs it.</p>
          </div>
        )
      ) : (
        <ul data-wb-secret-list="">
          {secrets.map((secret) => (
            <li key={secret.id} data-wb-secret="">
              <div data-wb-secret-head="">
                <strong>{secret.label}</strong>
                <span data-wb-secret-kind="">{secretKindLabel(secret.kind)}</span>
              </div>
              <code>{secret.name}</code>
              <small data-wb-secret-meta="">
                {describeAllowedOrigins(secret.allowedOrigins)} · {lastUsedLabel(secret.lastUsedAt)}
              </small>
              <div data-wb-secret-actions="">
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`Replace Value Of ${secret.label}`}
                  onClick={() => {
                    setNotice(null);
                    setDraft({
                      existing: secret,
                      name: secret.name,
                      label: secret.label,
                      kind: secret.kind,
                      sites: secret.allowedOrigins.join(" "),
                    });
                  }}
                >
                  Replace Value
                </button>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`Delete ${secret.label}`}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Delete the secret ${secret.name}? ${agent.profile.name} will no longer be able to use it.`,
                      )
                    )
                      return;
                    await run(secret.id, () =>
                      remove({ environmentId, input: { agentId, name: secret.name } }),
                    );
                  }}
                >
                  Delete
                </button>
              </div>
              {busy === secret.id && (
                <small role="status" data-wb-secret-meta="">
                  Deleting…
                </small>
              )}
              {notice?.scope === secret.id && (
                <p role="alert" data-wb-error="">
                  {notice.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SecretForm({
  draft,
  saving,
  disabled,
  error,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  saving: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: (fields: {
    name: string;
    label: string;
    kind: AgentSecretKind;
    allowedOrigins: ReadonlyArray<string>;
    value: string;
  }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(draft.name);
  const [label, setLabel] = useState(draft.label);
  const [kind, setKind] = useState(draft.kind);
  const [sites, setSites] = useState(draft.sites);
  // The only copy of the value. Cleared when the form is submitted, cancelled or unmounted.
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => () => setValue(""), []);
  const replacing = draft.existing !== null;
  const title = replacing ? "Replace Value" : "New Secret";

  const submit = async () => {
    if (disabled) return;
    const checked = checkSecretDraft({ name, label });
    if (!checked.ok) {
      setProblem(checked.message);
      return;
    }
    const valueProblem = secretValueProblem(value);
    if (valueProblem !== null) {
      setProblem(valueProblem);
      return;
    }
    const origins = parseAllowedOrigins(sites);
    if (!origins.ok) {
      setProblem(origins.message);
      return;
    }
    const sent = value;
    setValue("");
    setProblem(null);
    await onSubmit({ ...checked.fields, kind, allowedOrigins: origins.origins, value: sent });
  };

  return (
    <form
      data-wb-secret-form=""
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4>{title}</h4>
      <label>
        Name
        <input
          autoFocus={!replacing}
          required
          readOnly={replacing}
          maxLength={64}
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="STRIPE_API_KEY"
          value={name}
          onChange={(event) => setName(event.target.value.toUpperCase())}
        />
      </label>
      <label>
        Label
        <input
          required
          maxLength={120}
          placeholder="Stripe live API key"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(event) => setKind(event.target.value as AgentSecretKind)}>
          {AGENT_SECRET_KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Only Type It On This Site
        <input
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://app.example.com"
          value={sites}
          onChange={(event) => setSites(event.target.value)}
        />
        <small data-wb-secret-meta="">
          Optional. Separate several sites with spaces. Leave empty for Any Site.
        </small>
      </label>
      <label>
        Value
        <input
          autoFocus={replacing}
          required
          type="password"
          name="agent-secret-value"
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <small data-wb-secret-meta="">
        Stored on this environment's server and kept out of conversations. It is not shown again.
      </small>
      {(problem ?? error) && (
        <p role="alert" data-wb-error="">
          {problem ?? error}
        </p>
      )}
      <div data-wb-actions="">
        <button type="submit" data-wb-primary="" disabled={disabled}>
          {saving ? "Saving…" : "Save Secret"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setValue("");
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
