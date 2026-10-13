import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
// UnexpectedResponseError can extract error.message and discard code/param.
// Only this exact server message identifies rejected input without those fields.
const subscriptionInputErrorMessage =
  "User subscription sharing currently supports only text, image, and file messages, item references, additional tools, compaction summaries, reasoning items, Web Search call items, developer function and custom tool call items, and programmatic tool calling items. Remove unsupported input items or use an API key instead.";
const httpErrorMetadata =
  /^(?:, (?:url|cf-ray|request id|auth error|auth error code): [^\r\n]+)*$/u;
const legacyFailures = {
  subscription_sharing_v2_user_not_eligible: {
    message:
      "ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.",
    revoke: false,
  },
  subscription_sharing_usage_limit_exceeded: {
    message:
      "Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.",
    revoke: false,
  },
  subscription_sharing_usage_unavailable: {
    message: "ChatGPT usage is temporarily unavailable. Try again shortly.",
    revoke: false,
  },
  subscription_sharing_unsupported_capability: {
    message:
      "Codex used a feature that ChatGPT sharing does not support. Use another provider for this request.",
    revoke: false,
  },
  subscription_sharing_v2_client_not_enabled: {
    message:
      "This app is not enabled for this ChatGPT connection. Use your existing CLI or another provider.",
    revoke: false,
  },
  subscription_sharing_v2_route_not_supported: {
    message: "ChatGPT does not support this request route.",
    revoke: false,
  },
  subscription_sharing_v2_invalid_user: {
    message:
      "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
    revoke: false,
  },
  subscription_sharing_v2_user_unavailable: {
    message: "ChatGPT is temporarily unavailable. Try again shortly.",
    revoke: false,
  },
} as const;
const failures = {
  ...legacyFailures,
  subscription_sharing_user_not_eligible: legacyFailures.subscription_sharing_v2_user_not_eligible,
  subscription_sharing_route_not_supported:
    legacyFailures.subscription_sharing_v2_route_not_supported,
  subscription_sharing_invalid_user: legacyFailures.subscription_sharing_v2_invalid_user,
  subscription_sharing_user_unavailable: legacyFailures.subscription_sharing_v2_user_unavailable,
  chatpass_v2_scope_not_authorized: {
    message:
      "This ChatGPT grant does not authorize the request. Check the connection's sharing permissions.",
    revoke: false,
  },
  chatpass_v2_invalid_authorization_context: {
    message:
      "ChatGPT could not authorize this connection. Check the client and sharing permissions.",
    revoke: false,
  },
};

/** Native errors save the Responses JSON or Codex's HTTP-error display text. */
export function isCodexSubscriptionInputError(value: unknown): boolean {
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === "string") {
      const body = value.replace(/^unexpected status 400(?: Bad Request)?:\s*/u, "").trim();
      if (
        body.startsWith(subscriptionInputErrorMessage) &&
        httpErrorMetadata.test(body.slice(subscriptionInputErrorMessage.length))
      )
        return true;
      try {
        // Codex appends request metadata after the closing JSON object.
        value = decodeJson(
          body.replace(
            /\}\s*, (?:url|cf-ray|request id|auth error|auth error code): [^\r\n]+$/u,
            "}",
          ),
        );
        continue;
      } catch {
        return false;
      }
    }
    if (typeof value !== "object" || value === null) return false;
    if ("code" in value && "param" in value)
      return (
        value.code === "subscription_sharing_unsupported_capability" && value.param === "input"
      );
    if ("error" in value) value = value.error;
    else if ("message" in value) value = value.message;
    else return false;
  }
  return false;
}

export function classifyCodexManagedError(value: unknown) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  for (const [code, failure] of Object.entries(failures)) {
    if (!text.includes(code)) continue;
    if (code === "subscription_sharing_unsupported_capability") {
      if (text.includes("Remove unsupported input items") || text.includes("agent_message"))
        return {
          ...failure,
          code: "codex_unsupported_history",
          message:
            "ChatGPT sharing rejected an item in this session's history. A fresh session with a conversation summary can continue using the same model.",
        };
      if (text.includes("tool 'namespace'"))
        return {
          ...failure,
          code,
          message:
            "Codex sent a tool namespace that ChatGPT sharing does not support. Use another provider for this request.",
        };
      if (text.includes("additional_tools"))
        return {
          ...failure,
          code,
          message:
            "Codex sent an input item that ChatGPT sharing does not support. Use another provider for this request.",
        };
    }
    return { ...failure, code };
  }
  return undefined;
}
