import {
  AGENT_SECRET_VALUE_MAX_BYTES,
  WorkbenchAgentProfile,
  WorkspaceAgent,
  type AgentSecretRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SECRET_FALLBACK_ERROR,
  answerableRequests,
  checkSecretDraft,
  describeAllowedOrigins,
  parseAllowedOrigins,
  secretErrorMessage,
  secretValueProblem,
} from "./agentSecrets.ts";

function request(id: string, overrides: Partial<AgentSecretRequest> = {}): AgentSecretRequest {
  return {
    id,
    agentId: "agent-1",
    threadId: "thread-1",
    name: "STRIPE_API_KEY",
    label: "Stripe",
    reason: "To create a product.",
    kind: "api_key",
    status: "pending",
    createdAt: "2026-10-05T10:00:00.000Z",
    expiresAt: "2026-10-06T10:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  } as AgentSecretRequest;
}

describe("answerableRequests", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");

  it("lists waiting requests oldest first and drops expired ones", () => {
    const result = answerableRequests(
      [
        request("b", { createdAt: "2026-10-05T11:00:00.000Z" }),
        request("a", { createdAt: "2026-10-05T09:00:00.000Z" }),
        request("old", { expiresAt: "2026-10-05T11:59:59.000Z" }),
        request("done", { status: "provided" }),
      ],
      now,
    );
    expect(result.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("secretValueProblem", () => {
  it("counts bytes, not characters", () => {
    expect(secretValueProblem("")).not.toBeNull();
    expect(secretValueProblem("   ")).not.toBeNull();
    // Too short once the ends are trimmed, as the server counts it.
    expect(secretValueProblem("  abcde  ")).toContain("at least");
    expect(secretValueProblem("  abcdef  ")).toBeNull();
    expect(secretValueProblem("x".repeat(AGENT_SECRET_VALUE_MAX_BYTES))).toBeNull();
    expect(secretValueProblem("x".repeat(AGENT_SECRET_VALUE_MAX_BYTES + 1))).not.toBeNull();
    // Two bytes each, so half as many characters already overflow by one.
    expect(secretValueProblem("é".repeat(AGENT_SECRET_VALUE_MAX_BYTES / 2 + 1))).not.toBeNull();
  });
});

describe("checkSecretDraft", () => {
  it("accepts an env-var name and a label, trimming both", () => {
    expect(checkSecretDraft({ name: " STRIPE_API_KEY ", label: " Stripe " })).toEqual({
      ok: true,
      fields: { name: "STRIPE_API_KEY", label: "Stripe" },
    });
  });

  it("explains a bad name or label", () => {
    expect(checkSecretDraft({ name: "stripe key", label: "x" }).ok).toBe(false);
    expect(checkSecretDraft({ name: "OK_NAME", label: "  " }).ok).toBe(false);
  });
});

describe("secretErrorMessage", () => {
  it("uses fixed sentences and never the error's own text", () => {
    const error = { _tag: "AgentSecretError", reason: "request_expired", message: "sk_live_leak" };
    expect(secretErrorMessage(error)).toContain("expired");
    expect(secretErrorMessage(error)).not.toContain("sk_live_leak");
    expect(secretErrorMessage(new Error("sk_live_leak"))).toBe(SECRET_FALLBACK_ERROR);
  });
});

describe("agent sync", () => {
  it("cannot carry secrets, which are not on the agent document at all", () => {
    // Sync copies `WorkspaceAgent` documents between environments. A secret has no field there.
    const fields = [
      ...Object.keys(WorkspaceAgent.fields),
      ...Object.keys(WorkbenchAgentProfile.fields),
    ];
    expect(fields.filter((field) => /secret|credential|token/i.test(field))).toEqual([]);
  });
});

describe("parseAllowedOrigins", () => {
  it("normalises, de-duplicates and refuses anything but https or localhost", () => {
    expect(
      parseAllowedOrigins(
        "https://App.Example.com/path, https://app.example.com http://localhost:5173",
      ),
    ).toEqual({
      ok: true,
      origins: ["https://app.example.com", "http://localhost:5173"],
    });
    expect(parseAllowedOrigins("   ")).toEqual({ ok: true, origins: [] });
    expect(parseAllowedOrigins("http://example.com").ok).toBe(false);
    expect(parseAllowedOrigins("example.com").ok).toBe(false);
    expect(
      parseAllowedOrigins(Array.from({ length: 11 }, (_, i) => `https://s${i}.test`).join(" ")).ok,
    ).toBe(false);
  });

  it("reads as Any Site when there are none", () => {
    expect(describeAllowedOrigins([])).toBe("Any Site");
    expect(describeAllowedOrigins(["https://a.test", "https://b.test"])).toBe(
      "https://a.test, https://b.test",
    );
  });
});
