import {
  AGENT_SECRET_VALUE_MIN_LENGTH,
  OrchestratorMcpFailure,
  PreviewAutomationSecretUnavailableError,
  type AgentSecretError,
  type AgentSecretMcpFileInput,
  type AgentSecretMcpFileResult,
  type AgentSecretMcpListResult,
  type AgentSecretMcpRequestInput,
  type AgentSecretMcpRequestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as AgentSecrets from "../agents/AgentSecrets.ts";
import { holdsOrchestration, type McpInvocationScope } from "./McpInvocationContext.ts";

/**
 * Secret tools for agents. The rules live in `AgentSecrets`; this service only works out which
 * agent the calling thread belongs to and shapes the answer. The agent always comes from the
 * thread identity of the MCP credential, never from a tool argument, so a call can only name the
 * caller's own secrets. (An agent that can run commands on this machine is the server's own OS
 * user and could read the store directly; this is not a sandbox.) No method here returns a value
 * except `typingValue`, which exists for the browser typing tool alone.
 */
export class AgentSecretsMcpService extends Context.Service<
  AgentSecretsMcpService,
  {
    readonly request: (
      scope: McpInvocationScope,
      input: AgentSecretMcpRequestInput,
    ) => Effect.Effect<AgentSecretMcpRequestResult, OrchestratorMcpFailure>;
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentSecretMcpListResult, OrchestratorMcpFailure>;
    readonly file: (
      scope: McpInvocationScope,
      input: AgentSecretMcpFileInput,
    ) => Effect.Effect<AgentSecretMcpFileResult, OrchestratorMcpFailure>;
    /**
     * A function that masks the calling agent's secret values (and their URL-encoded forms) in
     * anything on its way back to the model, such as a browser tool result. It is best-effort:
     * it matches text, not meaning. Identity when the agent holds no secrets. When the values
     * cannot be read it fails, and the caller must withhold what it was about to return.
     */
    readonly redactor: (
      scope: McpInvocationScope,
    ) => Effect.Effect<(value: unknown) => unknown, PreviewAutomationSecretUnavailableError>;
    /**
     * The value for `preview_type`'s `secretName`, with the sites the owner limited it to (empty
     * means any). Works whatever the agent's tool groups, since the browser group is checked by
     * the typing tool itself.
     */
    readonly typingValue: (
      scope: McpInvocationScope,
      name: string,
    ) => Effect.Effect<
      { readonly value: Redacted.Redacted<string>; readonly allowedOrigins: ReadonlyArray<string> },
      PreviewAutomationSecretUnavailableError
    >;
  }
>()("t3/mcp/AgentSecretsMcpService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** What the agent is told. Fixed sentences per reason, so no value can find its way in. */
const secretFailure = (error: AgentSecretError) => {
  switch (error.reason) {
    case "storage":
    case "file_failed":
      return failure("orchestration_error", error.message);
    case "not_an_agent_thread":
      return failure("invalid_request", "This thread does not belong to an agent.");
    case "agent_archived":
      return failure("invalid_request", "This agent is archived, so its secrets cannot be used.");
    case "secret_not_found":
      return failure(
        "invalid_request",
        "This agent has no secret with that name. Use secret_list to see the names, or secret_request to ask the owner.",
      );
    case "secret_limit":
      return failure("invalid_request", "This agent already holds the most secrets it may.");
    case "request_declined_recently":
      return failure(
        "invalid_request",
        "The owner declined a request for this secret a moment ago. Do not ask for it again for 10 minutes; carry on without it or tell the owner what you need.",
      );
    case "request_limit":
      return failure(
        "invalid_request",
        "Too many secret requests are waiting for the owner. Finish your turn and wait for answers.",
      );
    default:
      return failure("invalid_request", error.message);
  }
};

const asFailure = <A, R>(
  effect: Effect.Effect<A, AgentSecretError | OrchestratorMcpFailure, R>,
): Effect.Effect<A, OrchestratorMcpFailure, R> =>
  effect.pipe(Effect.catchTag("AgentSecretError", (error) => Effect.fail(secretFailure(error))));

const typingFailure = (error: AgentSecretError, secretName: string) =>
  new PreviewAutomationSecretUnavailableError({
    secretName,
    reason:
      error.reason === "not_an_agent_thread" ||
      error.reason === "agent_archived" ||
      error.reason === "secret_not_found"
        ? error.reason
        : "storage",
  });

/** Values this short are refused when stored (`AGENT_SECRET_VALUE_MIN_LENGTH`), so every one can be masked. */
const MASK = "[secret]";

/** The value, as a URL would carry it: percent-encoded, and with `+` for spaces. */
const needlesFor = (value: string): ReadonlyArray<string> => {
  const encoded = encodeURIComponent(value);
  return [value, encoded, encoded.replaceAll("%20", "+")];
};

const maskText = (text: string, needles: ReadonlyArray<string>) =>
  needles.reduce((current, needle) => current.split(needle).join(MASK), text);

/** Replaces every occurrence of a secret value in the strings of a JSON-like value. */
const maskNeedles = (value: unknown, needles: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") return maskText(value, needles);
  if (Array.isArray(value)) return value.map((entry) => maskNeedles(entry, needles));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, maskNeedles(entry, needles)]),
    );
  }
  return value;
};

const make = Effect.gen(function* () {
  const secrets = yield* AgentSecrets.AgentSecrets;

  // Secrets belong to the calling agent, so they stay available when the owner switched Other
  // Conversations off: that switch is about reaching beyond the agent's own thread.
  const requireCapability = (scope: McpInvocationScope) =>
    holdsOrchestration(scope)
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  return AgentSecretsMcpService.of({
    request: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* secrets.agentForThread(scope.threadId);
        return yield* secrets.createRequest({
          agentId: agent.agentId,
          threadId: scope.threadId,
          name: input.name,
          label: input.label,
          reason: input.reason,
          kind: input.kind,
          suggestedOrigin: input.suggestedOrigin,
          replace: input.replace === true,
        });
      }).pipe(asFailure),
    list: (scope) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* secrets.agentForThread(scope.threadId);
        const { secrets: held } = yield* secrets.list({ agentId: agent.agentId });
        return {
          agentId: agent.agentId,
          secrets: held.map(({ name, label, kind, allowedOrigins }) => ({
            name,
            label,
            kind,
            allowedOrigins,
          })),
        };
      }).pipe(asFailure),
    file: (scope, input) =>
      Effect.gen(function* () {
        yield* requireCapability(scope);
        const agent = yield* secrets.agentForThread(scope.threadId);
        const path = yield* secrets.useFile({ agentId: agent.agentId, name: input.name });
        return { name: input.name, path };
      }).pipe(asFailure),
    redactor: (scope) =>
      secrets.valuesForThread(scope.threadId).pipe(
        Effect.mapError(
          () => new PreviewAutomationSecretUnavailableError({ reason: "masking_unavailable" }),
        ),
        Effect.map((held) => {
          const needles = held
            .map((value) => Redacted.value(value))
            .filter((value) => value.length >= AGENT_SECRET_VALUE_MIN_LENGTH)
            .flatMap(needlesFor)
            .toSorted((a, b) => b.length - a.length);
          return needles.length === 0
            ? (value: unknown) => value
            : (value: unknown) => maskNeedles(value, needles);
        }),
      ),
    typingValue: (scope, name) =>
      Effect.gen(function* () {
        const agent = yield* secrets.agentForThread(scope.threadId);
        return yield* secrets.useForTyping({ agentId: agent.agentId, name });
      }).pipe(Effect.mapError((error) => typingFailure(error, name))),
  });
});

export const layer: Layer.Layer<AgentSecretsMcpService, never, AgentSecrets.AgentSecrets> =
  Layer.effect(AgentSecretsMcpService, make);
