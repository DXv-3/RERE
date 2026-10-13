import {
  AGENT_SECRET_KIND_LABELS,
  AGENT_SECRET_ORIGINS_MAX,
  AGENT_SECRET_VALUE_MIN_LENGTH,
  normalizeAgentSecretOrigin,
  AGENT_SECRET_LABEL_MAX,
  AGENT_SECRET_MAX_PER_AGENT,
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_BYTES,
  type AgentSecretError,
  type AgentSecretKind,
  type AgentSecretRequest,
} from "@t3tools/contracts";

export const AGENT_SECRET_KIND_OPTIONS: ReadonlyArray<{
  readonly value: AgentSecretKind;
  readonly label: string;
}> = (Object.keys(AGENT_SECRET_KIND_LABELS) as AgentSecretKind[]).map((value) => ({
  value,
  label: AGENT_SECRET_KIND_LABELS[value],
}));

export function secretKindLabel(kind: AgentSecretKind): string {
  return AGENT_SECRET_KIND_LABELS[kind];
}

/**
 * The sentence shown for each way a secret call can fail. Errors are never shown as the server
 * worded them: a message built anywhere else could, by accident, quote what was typed.
 */
const SECRET_ERROR_MESSAGE: Record<AgentSecretError["reason"], string> = {
  agent_not_found: "This agent could not be found. Refresh and try again.",
  agent_archived: "This agent is archived, so it cannot use or ask for secrets.",
  secret_not_found: "This secret no longer exists. It may have been deleted on another device.",
  secret_limit: `An agent can hold up to ${AGENT_SECRET_MAX_PER_AGENT} secrets.`,
  request_not_found: "This request no longer exists.",
  request_limit: "This agent has too many requests waiting.",
  request_resolved: "This request was already answered.",
  request_expired: "This request expired after a day. Ask the agent to request it again.",
  value_empty: "Enter the value first.",
  value_too_short: `A secret needs at least ${AGENT_SECRET_VALUE_MIN_LENGTH} characters, not counting spaces at the ends.`,
  invalid_origin:
    "Use a site address like https://app.example.com. Only https works, except for localhost.",
  request_declined_recently: "You declined this a moment ago, so the agent cannot ask again yet.",
  value_too_large: `A secret can be up to ${AGENT_SECRET_VALUE_MAX_BYTES / 1024} KB.`,
  thread_unavailable:
    "The agent's conversation is not available, so it could not be told. Open the conversation and try again.",
  not_an_agent_thread: "This conversation does not belong to an agent.",
  file_failed: "The server could not update the secret's file. Try again.",
  storage: "The server could not save this. Try again.",
};

export const SECRET_FALLBACK_ERROR = "Could not reach the server. Try again.";

function secretErrorReason(error: unknown): AgentSecretError["reason"] | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, reason } = error as { _tag?: unknown; reason?: unknown };
  return _tag === "AgentSecretError" && typeof reason === "string" && reason in SECRET_ERROR_MESSAGE
    ? (reason as AgentSecretError["reason"])
    : null;
}

export function secretErrorMessage(error: unknown): string {
  const reason = secretErrorReason(error);
  return reason === null ? SECRET_FALLBACK_ERROR : SECRET_ERROR_MESSAGE[reason];
}

const encoder = new TextEncoder();

/** Whether a value fits the server's limits, measured as the server does: trimmed, then in bytes. */
export function secretValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return SECRET_ERROR_MESSAGE.value_empty;
  if (trimmed.length < AGENT_SECRET_VALUE_MIN_LENGTH) return SECRET_ERROR_MESSAGE.value_too_short;
  if (encoder.encode(trimmed).length > AGENT_SECRET_VALUE_MAX_BYTES)
    return SECRET_ERROR_MESSAGE.value_too_large;
  return null;
}

export type OriginsCheck =
  | { readonly ok: true; readonly origins: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

/** The sites typed into a form (separated by spaces or commas), normalised as the server will. */
export function parseAllowedOrigins(text: string): OriginsCheck {
  const entries = text.split(/[\s,]+/).filter((entry) => entry !== "");
  const origins: string[] = [];
  for (const entry of entries) {
    const origin = normalizeAgentSecretOrigin(entry);
    if (origin === null) return { ok: false, message: SECRET_ERROR_MESSAGE.invalid_origin };
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > AGENT_SECRET_ORIGINS_MAX)
    return { ok: false, message: `Limit a secret to at most ${AGENT_SECRET_ORIGINS_MAX} sites.` };
  return { ok: true, origins };
}

/** What a secret's sites read as in a list: "Any Site" when there are none. */
export function describeAllowedOrigins(origins: ReadonlyArray<string>): string {
  return origins.length === 0 ? "Any Site" : origins.join(", ");
}

export type SecretDraftCheck =
  | {
      readonly ok: true;
      readonly fields: { readonly name: string; readonly label: string };
    }
  | { readonly ok: false; readonly message: string };

/** The name and label of a new secret, checked up front. The value is checked by `secretValueProblem`. */
export function checkSecretDraft(input: {
  readonly name: string;
  readonly label: string;
}): SecretDraftCheck {
  const name = input.name.trim();
  const label = input.label.trim();
  if (!AGENT_SECRET_NAME_PATTERN.test(name))
    return {
      ok: false,
      message:
        "Use a name like STRIPE_API_KEY: capital letters, digits and underscores, starting with a letter.",
    };
  if (label === "") return { ok: false, message: "Give the secret a label you will recognise." };
  if (label.length > AGENT_SECRET_LABEL_MAX)
    return { ok: false, message: `Keep the label under ${AGENT_SECRET_LABEL_MAX} characters.` };
  return { ok: true, fields: { name, label } };
}

/** Requests still worth showing: waiting, and not past their expiry (the list only changes on writes). */
export function answerableRequests(
  requests: ReadonlyArray<AgentSecretRequest>,
  now: number,
): AgentSecretRequest[] {
  return requests
    .filter((request) => request.status === "pending" && Date.parse(request.expiresAt) > now)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

/** "Never Used", or "Last Used" and a short date. */
export function lastUsedLabel(lastUsedAt: string | null): string {
  if (lastUsedAt === null) return "Never Used";
  const parsed = Date.parse(lastUsedAt);
  return Number.isNaN(parsed)
    ? "Never Used"
    : `Last Used ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed)}`;
}
