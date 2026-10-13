import { describe, expect, it } from "vite-plus/test";

import { parseModelShareCode } from "./modelShareCode";
import {
  modelShareInstructions,
  modelShareInviteNotice,
  publicEnvironmentOrigin,
  UNREACHABLE_SHARE_NOTICE,
} from "./modelShareInstructions";

const created = {
  share: {
    id: "share-1",
    label: "Sam",
    providerInstanceId: "local",
    models: ["qwen38", "qwen38-think"],
    createdAt: "2026-10-06T00:00:00.000Z",
    lastUsedAt: null,
  },
  token: "cwm_secret",
};

describe("model share instructions", () => {
  it("gives the recipient the address, token and models to enter", () => {
    const text = modelShareInstructions({ created, origin: "https://code.example.com" });
    expect(text).toContain("ANTHROPIC_BASE_URL=https://code.example.com/api/model-share");
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN=cwm_secret");
    expect(text).toContain("qwen38, qwen38-think");
  });

  it("knows a public address only when the page was opened at one", () => {
    expect(
      publicEnvironmentOrigin({ origin: "http://127.0.0.1:3773", hostname: "127.0.0.1" }),
    ).toBe(null);
    expect(publicEnvironmentOrigin({ origin: "t3code://app", hostname: "app" })).toBe(null);
    expect(
      publicEnvironmentOrigin({ origin: "https://code.example.com", hostname: "code.example.com" }),
    ).toBe("https://code.example.com");
  });

  it("never hands out a placeholder address or a token that cannot be used", () => {
    const text = modelShareInstructions({ created, origin: null });
    expect(text).toBe(UNREACHABLE_SHARE_NOTICE);
    expect(text).not.toContain("<");
    expect(text).not.toContain("cwm_secret");
    expect(text).not.toContain("ANTHROPIC_BASE_URL");
    expect(text).toContain("Type their email");
  });

  it("includes a one-paste code that gives back the same address, token and models", () => {
    const text = modelShareInstructions({ created, origin: "https://code.example.com" });
    expect(parseModelShareCode(text)).toEqual({
      ok: true,
      access: {
        baseUrl: "https://code.example.com/api/model-share",
        token: "cwm_secret",
        models: ["qwen38", "qwen38-think"],
      },
    });
  });

  it("has no code to paste until it knows the address", () => {
    const text = modelShareInstructions({ created, origin: null });
    expect(text).not.toContain("codewrench-share:");
    expect(parseModelShareCode(text)).toEqual({ ok: false, error: "not_a_share_code" });
  });
});

describe("model share invite notice", () => {
  it("says the person was emailed only when the relay says it did", () => {
    expect(modelShareInviteNotice({ recipientEmail: "sam@example.com", emailed: true })).toBe(
      "Shared with sam@example.com. We emailed them, and it appears in their CodeWrench when they sign in.",
    );
    for (const emailed of [false, undefined]) {
      expect(modelShareInviteNotice({ recipientEmail: "sam@example.com", emailed })).toBe(
        "Shared with sam@example.com. It appears in their CodeWrench when they sign in.",
      );
    }
  });
});
