import { describe, expect, it } from "vite-plus/test";

import {
  buildSharedModelInstance,
  describeModelShareCodeError,
  formatModelShareCode,
  nameSharedModelInstance,
  MODEL_SHARE_CODE_SCHEME,
  parseModelShareCode,
  type ModelShareCodeError,
  type SharedModelAccess,
} from "./modelShareCode";

const access: SharedModelAccess = {
  baseUrl: "https://code.example.com/api/model-share",
  token: "cwm_Secret-Token.123",
  models: ["qwen38", "qwen38-think"],
};

function encode(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${MODEL_SHARE_CODE_SCHEME}${body}`;
}

const valid = { v: 1, url: access.baseUrl, token: access.token, models: access.models };

function refusal(input: string): ModelShareCodeError | null {
  const result = parseModelShareCode(input);
  return result.ok ? null : result.error;
}

describe("model share code", () => {
  it("round-trips the address, token and models", () => {
    const code = formatModelShareCode(access);
    expect(code.startsWith(MODEL_SHARE_CODE_SCHEME)).toBe(true);
    expect(code).not.toMatch(/\s/);
    expect(parseModelShareCode(code)).toEqual({ ok: true, access });
  });

  it("round-trips model names with unusual characters", () => {
    const unusual = { ...access, models: ["claude-opus-5-5[1m]", "gemma:27b/q4", "modèle-é"] };
    expect(parseModelShareCode(formatModelShareCode(unusual))).toEqual({
      ok: true,
      access: unusual,
    });
  });

  it("normalizes the address", () => {
    const result = parseModelShareCode(
      encode({ ...valid, url: "https://CODE.example.com/api/model-share/" }),
    );
    expect(result).toEqual({ ok: true, access });
    const lan = parseModelShareCode(
      encode({ ...valid, url: "http://192.168.1.5:3773/api/model-share" }),
    );
    expect(lan.ok && lan.access.baseUrl).toBe("http://192.168.1.5:3773/api/model-share");
  });

  it("ignores whitespace around and inside a pasted code", () => {
    const code = formatModelShareCode(access);
    expect(parseModelShareCode(`  \n${code}\t\n`)).toEqual({ ok: true, access });
    const wrapped = `${code.slice(0, 30)}\n${code.slice(30, 60)} \r\n${code.slice(60)}`;
    expect(parseModelShareCode(wrapped)).toEqual({ ok: true, access });
  });

  it("finds the code inside the message it was sent in", () => {
    const code = formatModelShareCode(access);
    const message = `Hi Sam, paste this into CodeWrench:\n${code}\n\nOr set it up by hand: ANTHROPIC_BASE_URL=x`;
    expect(parseModelShareCode(message)).toEqual({ ok: true, access });
  });

  it("refuses text with two codes rather than picking one", () => {
    const code = formatModelShareCode(access);
    const other = formatModelShareCode({ ...access, token: "cwm_other" });
    expect(refusal(`${code}\n${other}`)).toBe("not_a_share_code");
  });

  it("refuses empty input and the wrong scheme", () => {
    expect(refusal("")).toBe("empty");
    expect(refusal("   \n ")).toBe("empty");
    const body = formatModelShareCode(access).slice(MODEL_SHARE_CODE_SCHEME.length);
    for (const text of [
      body,
      `codewrench-share${body}`,
      `CODEWRENCH-SHARE:${body}`,
      `t3-share:${body}`,
      `https://example.com/${body}`,
      "ANTHROPIC_BASE_URL=https://code.example.com/api/model-share",
      "codewrench-share:",
    ]) {
      expect(refusal(text)).toBe("not_a_share_code");
    }
  });

  it("refuses a damaged payload", () => {
    expect(refusal(`${MODEL_SHARE_CODE_SCHEME}!!!`)).toBe("not_a_share_code");
    expect(refusal(`${MODEL_SHARE_CODE_SCHEME}a`)).toBe("malformed");
    expect(refusal(`${MODEL_SHARE_CODE_SCHEME}bm90IGpzb24`)).toBe("malformed");
    expect(refusal(encode("a string"))).toBe("malformed");
    expect(refusal(encode(null))).toBe("malformed");
    expect(refusal(encode([valid]))).toBe("malformed");
    const code = formatModelShareCode(access);
    expect(refusal(code.slice(0, -8))).not.toBe(null);
  });

  it("refuses a version it does not know, and unexpected fields", () => {
    expect(refusal(encode({ ...valid, v: 2 }))).toBe("unsupported_version");
    expect(refusal(encode({ ...valid, v: 0 }))).toBe("malformed");
    expect(refusal(encode({ ...valid, v: "1" }))).toBe("malformed");
    expect(refusal(encode({ url: valid.url, token: valid.token, models: valid.models }))).toBe(
      "malformed",
    );
    expect(refusal(encode({ ...valid, extra: true }))).toBe("malformed");
  });

  it("refuses an address that is not a plain http(s) model-share address", () => {
    for (const url of [
      undefined,
      42,
      "",
      "not a url",
      "ftp://code.example.com/api/model-share",
      "javascript:alert(1)",
      "https://user:pass@code.example.com/api/model-share",
      "https://code.example.com/api/model-share?x=1",
      "https://code.example.com/api/model-share#frag",
      "https://code.example.com/",
      "https://code.example.com/api/other",
      "https://code.example.com/x/api/model-share",
    ]) {
      expect(refusal(encode({ ...valid, url }))).toBe("invalid_address");
    }
  });

  it("refuses a missing or unusable token", () => {
    for (const token of [
      undefined,
      7,
      "",
      "has space",
      "tab\there",
      "new\nline",
      "a".repeat(513),
    ]) {
      expect(refusal(encode({ ...valid, token }))).toBe("invalid_token");
    }
  });

  it("refuses missing or unusable models", () => {
    for (const models of [
      undefined,
      "qwen38",
      [],
      [""],
      ["  "],
      [7],
      ["a,b"],
      ["line\nbreak"],
      ["same", "same"],
      ["m".repeat(201)],
      Array.from({ length: 33 }, (_, index) => `model-${index}`),
    ]) {
      expect(refusal(encode({ ...valid, models }))).toBe("invalid_models");
    }
  });

  it("will not write a code that could not be read back", () => {
    expect(() =>
      formatModelShareCode({
        ...access,
        baseUrl: "https://<this server's address>/api/model-share",
      }),
    ).toThrow();
    expect(() => formatModelShareCode({ ...access, token: "has space" })).toThrow();
    expect(() => formatModelShareCode({ ...access, models: [] })).toThrow();
  });

  it("never puts any of the code in a message for the person pasting", () => {
    const errors: ReadonlyArray<ModelShareCodeError> = [
      "empty",
      "not_a_share_code",
      "malformed",
      "unsupported_version",
      "invalid_address",
      "invalid_token",
      "invalid_models",
    ];
    for (const error of errors) {
      const text = describeModelShareCodeError(error);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(access.token);
    }
  });
});

describe("shared model provider instance", () => {
  it("is a Claude provider with the address, a sensitive token and the shared models", () => {
    expect(buildSharedModelInstance(access, "Shared: qwen38")).toEqual({
      driver: "claudeAgent",
      enabled: true,
      displayName: "Shared: qwen38",
      environment: [
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://code.example.com/api/model-share",
          sensitive: false,
        },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "cwm_Secret-Token.123", sensitive: true },
      ],
      config: { customModels: ["qwen38", "qwen38-think"] },
    });
  });

  it("only the token is sensitive", () => {
    const instance = buildSharedModelInstance(access, "x");
    expect(instance.environment?.filter((variable) => variable.sensitive)).toHaveLength(1);
    expect(instance.environment?.find((variable) => variable.sensitive)?.name).toBe(
      "ANTHROPIC_AUTH_TOKEN",
    );
  });
});

describe("nameSharedModelInstance", () => {
  it("names the provider after the first model and makes the id a valid slug", () => {
    expect(nameSharedModelInstance(access, new Set())).toEqual({
      instanceId: "claudeAgent_shared_qwen38",
      displayName: "Shared: qwen38",
    });
    const awkward = { ...access, models: ["Gemma:27B/Q4 [1m]"] };
    expect(nameSharedModelInstance(awkward, new Set()).instanceId).toMatch(
      /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    );
  });

  it("never reuses an id that is taken", () => {
    const taken = new Set(["claudeAgent_shared_qwen38", "claudeAgent_shared_qwen38_2"]);
    expect(nameSharedModelInstance(access, taken).instanceId).toBe("claudeAgent_shared_qwen38_3");
  });
});
