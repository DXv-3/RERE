import { assert, it } from "@effect/vitest";
import { classifyCodexManagedError, isCodexSubscriptionInputError } from "./CodexManagedErrors.ts";

const inputMessage =
  "User subscription sharing currently supports only text, image, and file messages, item references, additional tools, compaction summaries, reasoning items, Web Search call items, developer function and custom tool call items, and programmatic tool calling items. Remove unsupported input items or use an API key instead.";

it("recognizes HTTP-formatted and extracted input failures without matching other HTTP errors", () => {
  const json = JSON.stringify({
    error: { code: "subscription_sharing_unsupported_capability", param: "input" },
  });
  for (const message of [
    `unexpected status 400 Bad Request: ${json}`,
    `unexpected status 400: ${json}, url: https://example.com/responses, request id: example`,
    inputMessage,
    `unexpected status 400 Bad Request: ${inputMessage}`,
    `unexpected status 400 Bad Request: ${inputMessage}, url: https://example.com/responses, cf-ray: example`,
  ])
    assert.isTrue(isCodexSubscriptionInputError({ message }));
  for (const message of [
    `unexpected status 500 Internal Server Error: ${json}`,
    `unexpected status 400 Bad Request: ${JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools", message: inputMessage } })}`,
    `${inputMessage} Unrelated error`,
    `Other failure: ${inputMessage}`,
    "unexpected status 400 Bad Request: subscription_sharing_unsupported_capability",
  ])
    assert.isFalse(isCodexSubscriptionInputError({ message }));
});

it("recognizes saved native unsupported-input errors without resetting unrelated failures", () => {
  const error = {
    error: { code: "subscription_sharing_unsupported_capability", param: "input" },
  };
  for (const value of [error, JSON.stringify(error), { message: JSON.stringify(error) }])
    assert.isTrue(isCodexSubscriptionInputError(value));
  for (const value of [
    { error: { ...error.error, param: "tools" } },
    { error: { ...error.error, code: "subscription_sharing_usage_limit_exceeded" } },
    { message: "subscription_sharing_unsupported_capability" },
    "invalid JSON",
    null,
    undefined,
  ])
    assert.isFalse(isCodexSubscriptionInputError(value));
  const cyclic: { message?: unknown } = {};
  cyclic.message = cyclic;
  assert.isFalse(isCodexSubscriptionInputError(cyclic));
});
it("maps streamed failures to safe actionable messages and reconnect decisions", () => {
  assert.deepEqual(
    classifyCodexManagedError({
      error: {
        code: "subscription_sharing_v2_invalid_user",
        message: "opaque token dummy-sensitive",
      },
    }),
    {
      message:
        "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
      revoke: false,
      code: "subscription_sharing_v2_invalid_user",
    },
  );
  assert.include(
    classifyCodexManagedError("subscription_sharing_usage_limit_exceeded")!.message,
    "Usage settings",
  );
  assert.equal(
    classifyCodexManagedError("subscription_sharing_usage_limit_exceeded")!.code,
    "subscription_sharing_usage_limit_exceeded",
  );
  assert.isFalse(classifyCodexManagedError("subscription_sharing_usage_unavailable")!.revoke);
  assert.include(
    classifyCodexManagedError("subscription_sharing_unsupported_capability")!.message,
    "feature",
  );
  assert.isUndefined(classifyCodexManagedError(undefined));
  assert.isUndefined(classifyCodexManagedError({ error: "unknown" }));
});

it("distinguishes unsupported tools from input items without exposing the raw response", () => {
  const code = "subscription_sharing_unsupported_capability";
  for (const [detail, expected] of [
    ["tool 'namespace' is not supported", "tool namespace"],
    ["input item 'additional_tools' is not supported", "input item"],
  ]) {
    const response = { error: { code, message: `${detail}; dummy-sensitive` } };
    for (const value of [response, JSON.stringify(response)]) {
      const failure = classifyCodexManagedError(value);
      assert.isDefined(failure);
      assert.include(failure!.message, expected!);
      assert.notInclude(failure!.message, "dummy-sensitive");
      assert.isFalse(failure!.revoke);
    }
  }
});

it("preserves credentials for the current subscriber and permission error codes", () => {
  for (const code of [
    "subscription_sharing_invalid_user",
    "subscription_sharing_user_not_eligible",
    "subscription_sharing_route_not_supported",
    "subscription_sharing_user_unavailable",
    "chatpass_v2_scope_not_authorized",
    "chatpass_v2_invalid_authorization_context",
  ]) {
    assert.strictEqual(classifyCodexManagedError({ error: { code } })?.code, code);
    assert.isFalse(classifyCodexManagedError({ error: { code } })!.revoke);
  }
});

it("recognizes rejected native history without requiring a different model or API key", () => {
  const failure = classifyCodexManagedError({
    error: {
      code: "subscription_sharing_unsupported_capability",
      param: "input",
      message: "Remove unsupported input items or use an API key instead. dummy-sensitive",
    },
  });
  assert.equal(failure?.code, "codex_unsupported_history");
  assert.include(failure!.message, "same model");
  assert.notInclude(failure!.message, "dummy-sensitive");
  assert.isFalse(failure!.revoke);
});
