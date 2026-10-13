import { describe, expect, it } from "vite-plus/test";
import {
  createNativeSpeechLineParser,
  parseNativeSpeechLine,
  parseNativeSpeechProbe,
  probeAllowsApple,
} from "./nativeSpeechProtocol.ts";
import { resolveDictationEngine } from "./dictationEngine.ts";

describe("parseNativeSpeechLine", () => {
  it("reads each known event", () => {
    expect(parseNativeSpeechLine('{"type":"ready"}')).toEqual({ type: "ready" });
    expect(parseNativeSpeechLine('{"type":"partial","text":"hello wor"}')).toEqual({
      type: "partial",
      text: "hello wor",
    });
    expect(parseNativeSpeechLine('{"type":"final","text":"hello world"}')).toEqual({
      type: "final",
      text: "hello world",
    });
    expect(parseNativeSpeechLine('{"type":"silence"}')).toEqual({ type: "silence" });
    expect(
      parseNativeSpeechLine('{"type":"error","code":"permission_denied","message":"No"}'),
    ).toEqual({
      type: "error",
      code: "permission_denied",
      message: "No",
    });
  });

  it("ignores blank, broken, unknown and malformed lines", () => {
    for (const line of [
      "",
      "  ",
      "not json",
      "42",
      "null",
      '{"type":"wat"}',
      '{"type":"partial"}',
    ]) {
      expect(parseNativeSpeechLine(line)).toBeNull();
    }
  });

  it("fills in a missing error code and message", () => {
    expect(parseNativeSpeechLine('{"type":"error"}')).toEqual({
      type: "error",
      code: "unknown",
      message: "Speech recognition failed.",
    });
  });
});

describe("createNativeSpeechLineParser", () => {
  it("holds a line split across chunks until it is complete", () => {
    const parser = createNativeSpeechLineParser();
    expect(parser.push('{"type":"par')).toEqual([]);
    expect(parser.push('tial","text":"hi"}\n{"type":"ready"}\n')).toEqual([
      { type: "partial", text: "hi" },
      { type: "ready" },
    ]);
  });

  it("flushes a last line that has no newline, and skips junk between lines", () => {
    const parser = createNativeSpeechLineParser();
    expect(parser.push('oops\n{"type":"silence"}')).toEqual([]);
    expect(parser.flush()).toEqual([{ type: "silence" }]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("probe", () => {
  it("allows Apple only when supported and on-device", () => {
    const ok = parseNativeSpeechProbe(
      '{"supported":true,"onDevice":true,"locale":"en-US","engine":"sfspeech"}\n',
    );
    expect(probeAllowsApple(ok)).toBe(true);
    expect(probeAllowsApple(parseNativeSpeechProbe('{"supported":true,"onDevice":false}'))).toBe(
      false,
    );
    expect(probeAllowsApple(parseNativeSpeechProbe("garbage"))).toBe(false);
    expect(probeAllowsApple(parseNativeSpeechProbe(""))).toBe(false);
  });
});

describe("resolveDictationEngine", () => {
  it("auto picks Apple only when it is available", () => {
    expect(resolveDictationEngine("auto", true)).toBe("apple");
    expect(resolveDictationEngine("auto", false)).toBe("whisper");
  });
  it("honours an explicit choice but never uses an unavailable Apple", () => {
    expect(resolveDictationEngine("whisper", true)).toBe("whisper");
    expect(resolveDictationEngine("apple", true)).toBe("apple");
    expect(resolveDictationEngine("apple", false)).toBe("whisper");
  });
});
