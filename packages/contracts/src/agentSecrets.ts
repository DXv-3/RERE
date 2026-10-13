import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const id = text(240).check(Schema.isMinLength(1));

/** Env-var style, so an agent can name a secret the way a command would read it. */
export const AGENT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const AgentSecretName = Schema.String.check(
  Schema.isPattern(AGENT_SECRET_NAME_PATTERN),
).annotate({
  description:
    "The secret's name: capital letters, digits and underscores, starting with a letter, up to 64 characters, for example STRIPE_API_KEY.",
});
export type AgentSecretName = typeof AgentSecretName.Type;

export const AgentSecretKind = Schema.Literals(["api_key", "token", "password", "other"]);
export type AgentSecretKind = typeof AgentSecretKind.Type;
export const AGENT_SECRET_KIND_LABELS: Readonly<Record<AgentSecretKind, string>> = {
  api_key: "API Key",
  token: "Token",
  password: "Password",
  other: "Other",
};

export const AGENT_SECRET_LABEL_MAX = 120;
export const AGENT_SECRET_REASON_MAX = 1_000;
/** Measured in UTF-8 bytes and enforced by the service, so a refusal never has to quote the value. */
export const AGENT_SECRET_VALUE_MAX_BYTES = 16 * 1024;
export const AGENT_SECRET_MAX_PER_AGENT = 50;
export const AGENT_SECRET_MAX_PENDING_PER_AGENT = 5;
/** Shorter values would match ordinary page text, so none is stored: there would be nothing to mask. */
export const AGENT_SECRET_VALUE_MIN_LENGTH = 6;
export const AGENT_SECRET_ORIGINS_MAX = 10;
export const AGENT_SECRET_ORIGIN_MAX_LENGTH = 200;
/** After the owner declines a request, the agent cannot ask for the same name again for this long. */
export const AGENT_SECRET_DECLINE_COOLDOWN_MS = 10 * 60 * 1_000;
/** A request nobody answered within this long reads as expired. */
export const AGENT_SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;

export const AgentSecretLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_SECRET_LABEL_MAX),
);

/**
 * SENSITIVE. The one place a secret's value crosses the wire. It decodes straight into
 * `Redacted<string>` so a log line or a span that touches the payload prints `<redacted>`.
 * It deliberately carries no length or content check: a failed check would put the value into
 * the error text. The service enforces the size limits and does not repeat the value.
 */
export const AgentSecretValue = Schema.RedactedFromValue(Schema.String).annotate({
  description:
    "SENSITIVE. The secret's value. Kept out of logs, the database and tool results by default.",
});

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `new URL(raw).origin` for a site a secret may be typed on, or null. Only https is accepted, apart
 * from plain http on localhost.
 */
export const normalizeAgentSecretOrigin = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    const allowed =
      url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname));
    return allowed ? url.origin : null;
  } catch {
    return null;
  }
};

/** Sites the owner allows a secret to be typed on. Empty means any site. */
export const AgentSecretAllowedOrigins = Schema.Array(text(AGENT_SECRET_ORIGIN_MAX_LENGTH)).check(
  Schema.isMaxLength(AGENT_SECRET_ORIGINS_MAX),
);

/** Metadata only. There is no field for a value anywhere in this shape. */
export const AgentSecretSummary = Schema.Struct({
  id,
  agentId: id,
  name: AgentSecretName,
  label: text(AGENT_SECRET_LABEL_MAX),
  kind: AgentSecretKind,
  /** Normalised origins the browser tool may type this secret on; empty means any site. */
  allowedOrigins: AgentSecretAllowedOrigins,
  createdAt: text(80),
  updatedAt: text(80),
  lastUsedAt: Schema.NullOr(text(80)),
});
export type AgentSecretSummary = typeof AgentSecretSummary.Type;

export const AgentSecretRequestStatus = Schema.Literals([
  "pending",
  "provided",
  "declined",
  "expired",
]);
export type AgentSecretRequestStatus = typeof AgentSecretRequestStatus.Type;

export const AgentSecretRequest = Schema.Struct({
  id,
  agentId: id,
  threadId: ThreadId,
  name: AgentSecretName,
  label: text(AGENT_SECRET_LABEL_MAX),
  /** The agent's own words, cleaned of control characters. Untrusted: show it as a quotation. */
  reason: text(AGENT_SECRET_REASON_MAX),
  kind: AgentSecretKind,
  /** A site the agent suggests limiting the secret to. Untrusted; the owner decides. */
  suggestedOrigin: Schema.NullOr(text(AGENT_SECRET_ORIGIN_MAX_LENGTH)),
  /** Answering would overwrite a secret of this name the owner already saved. */
  replaces: Schema.Boolean,
  status: AgentSecretRequestStatus,
  createdAt: text(80),
  /** When an unanswered request starts reading as expired. */
  expiresAt: text(80),
  resolvedAt: Schema.NullOr(text(80)),
});
export type AgentSecretRequest = typeof AgentSecretRequest.Type;

export const AgentSecretList = Schema.Struct({ secrets: Schema.Array(AgentSecretSummary) });
export type AgentSecretList = typeof AgentSecretList.Type;
/** Only the requests still waiting for the owner. */
export const AgentSecretRequestList = Schema.Struct({ requests: Schema.Array(AgentSecretRequest) });
export type AgentSecretRequestList = typeof AgentSecretRequestList.Type;

export const AgentSecretListInput = Schema.Struct({ agentId: Schema.optional(id) });
export type AgentSecretListInput = typeof AgentSecretListInput.Type;

export const AgentSecretSetInput = Schema.Struct({
  agentId: id,
  name: AgentSecretName,
  label: AgentSecretLabel,
  kind: AgentSecretKind,
  /** Omitted keeps the stored list when replacing, and means any site for a new secret. */
  allowedOrigins: Schema.optional(AgentSecretAllowedOrigins),
  value: AgentSecretValue,
});
export type AgentSecretSetInput = typeof AgentSecretSetInput.Type;

export const AgentSecretDeleteInput = Schema.Struct({ agentId: id, name: AgentSecretName });
export type AgentSecretDeleteInput = typeof AgentSecretDeleteInput.Type;
export const AgentSecretDeleteResult = Schema.Struct({ name: AgentSecretName });
export type AgentSecretDeleteResult = typeof AgentSecretDeleteResult.Type;

export const AgentSecretRequestProvideInput = Schema.Struct({
  requestId: id,
  /** Used only for a new secret. Replacing keeps the stored sites. */
  allowedOrigins: Schema.optional(AgentSecretAllowedOrigins),
  value: AgentSecretValue,
});
export type AgentSecretRequestProvideInput = typeof AgentSecretRequestProvideInput.Type;
export const AgentSecretRequestDeclineInput = Schema.Struct({ requestId: id });
export type AgentSecretRequestDeclineInput = typeof AgentSecretRequestDeclineInput.Type;

export class AgentSecretError extends Schema.TaggedError<AgentSecretError>()("AgentSecretError", {
  reason: Schema.Literals([
    "agent_not_found",
    "agent_archived",
    "secret_not_found",
    "secret_limit",
    "request_not_found",
    "request_limit",
    "request_resolved",
    "request_expired",
    "value_empty",
    "value_too_short",
    "value_too_large",
    "invalid_origin",
    "request_declined_recently",
    "thread_unavailable",
    "not_an_agent_thread",
    "file_failed",
    "storage",
  ]),
}) {
  /** Fixed text per reason. It must never be built from a value. */
  override get message() {
    return `Agent secrets: ${this.reason.replaceAll("_", " ")}.`;
  }
}

// The MCP tools take no agent id: the server resolves the calling thread's own agent, so an agent
// can only ever see and use its own secrets.
export const AgentSecretMcpRequestInput = Schema.Struct({
  name: AgentSecretName,
  label: AgentSecretLabel.annotate({
    description: "What the owner sees, for example 'Stripe live API key'.",
  }),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_SECRET_REASON_MAX)).annotate({
    description: "Why you need it, in a sentence. The owner reads this before answering.",
  }),
  kind: AgentSecretKind,
  suggestedOrigin: Schema.optional(
    text(AGENT_SECRET_ORIGIN_MAX_LENGTH).annotate({
      description:
        "A site the secret is meant for, for example https://app.instantly.ai. The owner sees it as your suggestion and decides whether the secret is limited to it.",
    }),
  ),
  replace: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Ask again even though a secret with this name exists, for example because it stopped working.",
    }),
  ),
});
export type AgentSecretMcpRequestInput = typeof AgentSecretMcpRequestInput.Type;

export const AgentSecretMcpRequestResult = Schema.Struct({
  status: Schema.Literals(["requested", "available"]),
  name: AgentSecretName,
  requestId: Schema.optional(id),
});
export type AgentSecretMcpRequestResult = typeof AgentSecretMcpRequestResult.Type;

export const AgentSecretMcpListResult = Schema.Struct({
  agentId: id,
  secrets: Schema.Array(
    Schema.Struct({
      name: AgentSecretName,
      label: text(AGENT_SECRET_LABEL_MAX),
      kind: AgentSecretKind,
      allowedOrigins: AgentSecretAllowedOrigins,
    }),
  ),
});
export type AgentSecretMcpListResult = typeof AgentSecretMcpListResult.Type;

export const AgentSecretMcpFileInput = Schema.Struct({ name: AgentSecretName });
export type AgentSecretMcpFileInput = typeof AgentSecretMcpFileInput.Type;
export const AgentSecretMcpFileResult = Schema.Struct({
  name: AgentSecretName,
  path: Schema.String,
});
export type AgentSecretMcpFileResult = typeof AgentSecretMcpFileResult.Type;

/** What the owner's queued message says; the same words everywhere, and never the value. */
export const agentSecretProvidedMessage = (name: string): string =>
  `The owner provided the secret ${name}. Use secret_file or the browser typing tool's secretName to use it. Do not print its value.`;
export const agentSecretDeclinedMessage = (name: string): string =>
  `The owner declined to provide the secret ${name}.`;
