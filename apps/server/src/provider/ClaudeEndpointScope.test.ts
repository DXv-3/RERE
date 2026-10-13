import { describe, expect, it } from "vite-plus/test";

import {
  claudeInstanceListsOnlyCustomModels,
  claudeUsesCustomEndpoint,
  isCustomOnlyClaudeModelList,
} from "./ClaudeEndpointScope.ts";

const custom = ["qwen38", "qwen38-think"];

describe("claudeUsesCustomEndpoint", () => {
  it("treats unset, blank, invalid, and Anthropic's own host as the default endpoint", () => {
    expect(claudeUsesCustomEndpoint({})).toBe(false);
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "  " })).toBe(false);
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "not a url" })).toBe(false);
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(
      false,
    );
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "https://API.Anthropic.com/v1" })).toBe(
      false,
    );
  });

  it("detects a gateway on another host or port", () => {
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "http://127.0.0.1:4017" })).toBe(true);
    expect(claudeUsesCustomEndpoint({ ANTHROPIC_BASE_URL: "https://llm.example.com" })).toBe(true);
  });
});

describe("claudeInstanceListsOnlyCustomModels", () => {
  const gateway = { ANTHROPIC_BASE_URL: "http://127.0.0.1:4017" };

  it("lists only custom models on a custom endpoint that declares some", () => {
    expect(
      claudeInstanceListsOnlyCustomModels({ environment: gateway, customModels: custom }),
    ).toBe(true);
  });

  it("keeps the built-ins on a custom endpoint with no custom models", () => {
    expect(claudeInstanceListsOnlyCustomModels({ environment: gateway, customModels: [] })).toBe(
      false,
    );
    expect(
      claudeInstanceListsOnlyCustomModels({ environment: gateway, customModels: ["  "] }),
    ).toBe(false);
  });

  it("keeps the built-ins on Anthropic's own endpoint", () => {
    expect(claudeInstanceListsOnlyCustomModels({ environment: {}, customModels: custom })).toBe(
      false,
    );
  });
});

describe("isCustomOnlyClaudeModelList", () => {
  const builtIn = { slug: "claude-opus", name: "Opus", isCustom: false } as never;
  const qwen = { slug: "qwen38", name: "qwen38", isCustom: true } as never;

  it("recognizes a scoped Claude list so stale built-ins are not merged back", () => {
    expect(isCustomOnlyClaudeModelList("claudeAgent", [qwen])).toBe(true);
    expect(isCustomOnlyClaudeModelList("claudeAgent", [builtIn, qwen])).toBe(false);
    expect(isCustomOnlyClaudeModelList("claudeAgent", [])).toBe(false);
    expect(isCustomOnlyClaudeModelList("codex", [qwen])).toBe(false);
  });
});
