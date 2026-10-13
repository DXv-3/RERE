import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_SECRET_KIND_LABELS,
  type AgentSecretRequest,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  answerableRequests,
  parseAllowedOrigins,
  secretErrorMessage,
  secretValueProblem,
} from "@t3tools/client-runtime/operations/agent-secrets";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AgentAvatar } from "./AgentAvatar";
import { pickSecretRequest, secretRequestKey, useSecretPromptStore } from "./secretPromptStore";
import { usePendingSecretRequests } from "./useAgentSecrets";
import { useWorkbenchStore } from "./workbenchStore";
import { useWorkbenchPreferences } from "./workbenchPreferences";

interface Waiting {
  readonly environmentId: EnvironmentId;
  readonly request: AgentSecretRequest;
}

/** Re-renders now and then so a request that ran out its day stops being offered. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function SecretRequestHost({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const visible = useWorkbenchStore(
    (state) =>
      state.mode === "thread" || (state.mode === "agent" && state.agentView === "conversation"),
  );
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const host = { environmentId, threadId, element };
      useSecretPromptStore.getState().setHost(host);
      return () => useSecretPromptStore.getState().clearHost(element);
    },
    [environmentId, threadId],
  );
  return visible ? <div ref={attach} data-wb-secret-host="" /> : null;
}

/**
 * Asks the owner for a secret an agent requested, one request at a time, whichever tab is open:
 * inside the conversation on screen when there is one, and in a dialog otherwise.
 *
 * It listens to two environments: the one the Agent tab works against (which is where the agents
 * the owner is looking at run) and this device's own, so a request from a local agent is never
 * missed while the tab points at a remote one. The typed value lives only in the form's local
 * state, is sent once inside `Redacted`, and is cleared on submit, on close and on unmount.
 */
export function SecretRequestPrompt() {
  const host = useSecretPromptStore((state) => state.host);
  const { agentEnvironmentId } = useWorkbenchPreferences();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const { environments } = useEnvironments();
  const connectedIds = useConnectedEnvironmentIds();
  const tabEnvironmentId =
    host?.environmentId ??
    ((environments.some((entry) => entry.environmentId === agentEnvironmentId)
      ? agentEnvironmentId
      : primaryEnvironmentId) as EnvironmentId | null);
  const ownEnvironmentId =
    primaryEnvironmentId !== null && primaryEnvironmentId !== tabEnvironmentId
      ? (primaryEnvironmentId as EnvironmentId)
      : null;
  const fromTab = usePendingSecretRequests(
    tabEnvironmentId,
    tabEnvironmentId !== null && connectedIds.includes(tabEnvironmentId),
  );
  const fromOwn = usePendingSecretRequests(
    ownEnvironmentId,
    ownEnvironmentId !== null && connectedIds.includes(ownEnvironmentId),
  );
  const dismissed = useSecretPromptStore((state) => state.dismissed);
  const dismiss = useSecretPromptStore((state) => state.dismiss);
  const now = useNow(60_000);

  const waiting: Waiting[] = [
    ...(tabEnvironmentId === null
      ? []
      : answerableRequests(fromTab.requests, now).map((request) => ({
          environmentId: tabEnvironmentId,
          request,
        }))),
    ...(ownEnvironmentId === null
      ? []
      : answerableRequests(fromOwn.requests, now).map((request) => ({
          environmentId: ownEnvironmentId,
          request,
        }))),
  ];
  const open = waiting.filter(
    (entry) => !dismissed.has(secretRequestKey(entry.environmentId, entry.request.id)),
  );
  const picked = pickSecretRequest(open, host);
  if (!picked) return null;
  const { current, inline } = picked;
  const prompt = (
    <SecretRequestDialog
      inline={inline}
      elsewhere={picked.elsewhere}
      // A new request starts with an empty form; nothing typed for one carries to the next.
      key={secretRequestKey(current.environmentId, current.request.id)}
      environmentId={current.environmentId}
      request={current.request}
      position={1}
      total={open.length}
      onDismiss={() => dismiss(secretRequestKey(current.environmentId, current.request.id))}
      isThisDevice={current.environmentId === primaryEnvironmentId}
      environmentLabel={
        environments.find((entry) => entry.environmentId === current.environmentId)?.label ??
        "another environment"
      }
    />
  );
  return inline && host ? createPortal(prompt, host.element) : prompt;
}

function SecretRequestDialog({
  inline,
  elsewhere,
  environmentId,
  request,
  position,
  total,
  onDismiss,
  isThisDevice,
  environmentLabel,
}: {
  inline: boolean;
  /** Shown in a conversation other than the one the asking agent works in. */
  elsewhere: boolean;
  environmentId: EnvironmentId;
  request: AgentSecretRequest;
  position: number;
  total: number;
  onDismiss: () => void;
  isThisDevice: boolean;
  environmentLabel: string;
}) {
  const provide = useAtomCommand(serverEnvironment.agentSecretRequestsProvide, {
    reportFailure: false,
    reportDefect: false,
  });
  const decline = useAtomCommand(serverEnvironment.agentSecretRequestsDecline, {
    reportFailure: false,
    reportDefect: false,
  });
  const agents = useEnvironmentQuery(serverEnvironment.agentList({ environmentId, input: {} }));
  const agent = agents.data?.find((entry) => entry.profile.id === request.agentId);

  // The only copy of what the owner types. Never written to a store, storage, a URL or a log.
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  // The agent's suggestion starts in the box so it is visible; clearing it allows any site.
  const [sites, setSites] = useState(request.suggestedOrigin ?? "");
  const [busy, setBusy] = useState<"save" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The dialog opens with focus on its heading, so a keystroke meant for something else cannot land
  // in the value field, and Enter or Space cannot answer the request.
  const heading = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const sitesId = useId();
  const reasonId = useId();
  const errorId = useId();
  // Unmounting, which also happens when the request goes away or the tab is closed, drops the value.
  useEffect(() => () => setValue(""), []);

  /** Shows a failure in fixed words; the server's own text is never displayed. */
  const showFailure = (result: AtomCommandResult<unknown, unknown>) => {
    setBusy(null);
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setError(secretErrorMessage(squashAtomCommandFailure(result)));
  };

  const save = async () => {
    if (busy) return;
    const problem = secretValueProblem(value);
    if (problem !== null) {
      setError(problem);
      return;
    }
    // Replacing keeps the sites already saved, so the site box does not apply.
    const origins = request.replaces ? null : parseAllowedOrigins(sites);
    if (origins !== null && !origins.ok) {
      setError(origins.message);
      return;
    }
    const secret = Redacted.make(value);
    // Cleared at once: what stays on screen is an empty box, whatever the server answers.
    setValue("");
    setShown(false);
    setBusy("save");
    setError(null);
    const result = await provide({
      environmentId,
      input: {
        requestId: request.id,
        value: secret,
        ...(origins === null ? {} : { allowedOrigins: origins.origins }),
      },
    });
    showFailure(result);
  };

  const decide = async () => {
    if (busy) return;
    setValue("");
    setBusy("decline");
    setError(null);
    const result = await decline({ environmentId, input: { requestId: request.id } });
    showFailure(result);
  };

  const storageNote = isThisDevice
    ? "Stored on this machine and kept out of chat. An agent with shell access could still read it."
    : `Stored on ${environmentLabel} and kept out of chat. An agent with shell access there could still read it.`;
  const Footer = inline ? "div" : AlertDialogFooter;
  const content = (
    <div className="contents">
      {/* Saving requires activating its button, never Enter in a field. */}
      {inline ? (
        <header data-wb-secret-card-heading="">
          <h3>{request.label}</h3>
          <p>{storageNote}</p>
        </header>
      ) : (
        <AlertDialogHeader ref={heading} tabIndex={-1}>
          <AlertDialogTitle>{request.label}</AlertDialogTitle>
          <AlertDialogDescription>{storageNote}</AlertDialogDescription>
        </AlertDialogHeader>
      )}
      <div data-wb-secret-body="">
        {total > 1 && <small data-wb-secret-meta="">{`Request ${position} Of ${total}`}</small>}
        <div data-wb-secret-agent="">
          {agent ? <AgentAvatar agent={agent.profile} size={36} /> : null}
          <div>
            <strong>{agent?.profile.name ?? "An Agent"}</strong>
            <small data-wb-secret-meta="">
              {elsewhere
                ? `${AGENT_SECRET_KIND_LABELS[request.kind]} · Asked from its own conversation`
                : AGENT_SECRET_KIND_LABELS[request.kind]}
            </small>
          </div>
        </div>
        {/* The name is validated server-side to capitals, digits and underscores. */}
        <p data-wb-secret-name="">
          <code>{request.name}</code>
        </p>
        {request.replaces && (
          <p data-wb-secret-replaces="" role="alert">
            {`This Replaces The Secret ${request.name} You Saved Earlier`}
          </p>
        )}
        <figure data-wb-secret-reason="" aria-label="What the agent wrote">
          <figcaption>The agent says</figcaption>
          <blockquote id={reasonId}>
            <span data-wb-secret-quoted-label="">{request.label}</span>
            {request.reason}
          </blockquote>
        </figure>
        <label htmlFor={inputId} data-wb-secret-field="">
          Value
          <span data-wb-secret-input="">
            <input
              id={inputId}
              type={shown ? "text" : "password"}
              name="agent-secret-value"
              value={value}
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-form-type="other"
              aria-describedby={`${reasonId}${error ? ` ${errorId}` : ""}`}
              aria-invalid={error ? true : undefined}
              disabled={busy !== null}
              onKeyDown={(event) => {
                // Saving takes a click or a key press on the Save button itself.
                if (event.key === "Enter") event.preventDefault();
              }}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
            />
            <button
              type="button"
              aria-pressed={shown}
              aria-label={shown ? "Hide Value" : "Show Value"}
              onClick={() => setShown((current) => !current)}
            >
              {shown ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </label>
        {!request.replaces && (
          <label htmlFor={sitesId} data-wb-secret-field="">
            Only Type It On This Site
            <span data-wb-secret-input="">
              <input
                id={sitesId}
                type="text"
                name="agent-secret-sites"
                value={sites}
                placeholder="https://app.example.com"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                disabled={busy !== null}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                onChange={(event) => setSites(event.target.value)}
              />
            </span>
            <small data-wb-secret-meta="">
              {request.suggestedOrigin !== null
                ? "The agent suggested this site. It is only a suggestion; clear it to allow any site."
                : "Optional. Leave empty to allow any site."}
            </small>
          </label>
        )}
        {error && (
          <p id={errorId} role="alert" data-wb-error="">
            {error}
          </p>
        )}
      </div>
      <Footer data-wb-secret-footer="">
        {inline && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              setValue("");
              onDismiss();
            }}
          >
            Later
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void decide()}
        >
          {busy === "decline" ? "Declining…" : "Decline"}
        </Button>
        <Button type="button" disabled={busy !== null || value === ""} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : "Save securely"}
        </Button>
      </Footer>
    </div>
  );
  if (inline)
    return (
      <section data-wb-secret-card="" aria-label="Save an agent credential">
        {content}
      </section>
    );
  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) {
          setValue("");
          onDismiss();
        }
      }}
    >
      <AlertDialogPopup initialFocus={heading} data-wb-secret-dialog="">
        {content}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
