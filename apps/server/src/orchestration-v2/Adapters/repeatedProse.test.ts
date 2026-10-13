import { describe, expect, it } from "@effect/vitest";
import { RepeatedProseGuard } from "./repeatedProse.ts";

const paragraph =
  "Let me try to use the WebKit inspector to evaluate JavaScript. I'll use a Python script to connect to the WebKit inspector via a Unix socket. Actually, let me try a completely different approach first. ";

describe("RepeatedProseGuard", () => {
  it.each([" ", "\n", "\n\n"])("detects consecutive prose separated by %j", (separator) => {
    const text = Array.from({ length: 50 }, () => paragraph.trim()).join(separator);
    expect(new RepeatedProseGuard().append(text)).toBe(true);
    for (const chunkSize of [1, 17, 251]) {
      const guard = new RepeatedProseGuard();
      let stopped = false;
      for (let index = 0; index < text.length && !stopped; index += chunkSize) {
        stopped = guard.append(text.slice(index, index + chunkSize));
      }
      expect(stopped).toBe(true);
    }
  });

  it("excludes fenced repetitions across streaming boundaries and permits long label lists", () => {
    for (const fence of ["```", "~~~"]) {
      const guard = new RepeatedProseGuard();
      const text = `${fence}text\n${paragraph.repeat(50)}\n${fence}\n`;
      for (let index = 0; index < text.length; index += 17) {
        expect(guard.append(text.slice(index, index + 17))).toBe(false);
      }
      expect(guard.append(paragraph.repeat(50))).toBe(true);
    }
    expect(new RepeatedProseGuard().append("Working ".repeat(1000))).toBe(false);
  });
  it("detects a stuck response across arbitrary streaming boundaries", () => {
    const guard = new RepeatedProseGuard();
    const text = `${paragraph}\n\n`.repeat(15);
    let stopped = false;
    for (let i = 0; i < text.length; i += 17) {
      if (guard.append(text.slice(i, i + 17))) {
        stopped = true;
        break;
      }
    }
    expect(stopped).toBe(true);
  });
  it("allows occasional repetition, short labels, code, and distinct progress", () => {
    expect(new RepeatedProseGuard().append(`${paragraph}\n\n`.repeat(3))).toBe(false);
    expect(new RepeatedProseGuard().append("Working\n\n".repeat(100))).toBe(false);
    expect(
      new RepeatedProseGuard().append(`\`\`\`text\n${`${paragraph}\n\n`.repeat(30)}\n\`\`\`\n`),
    ).toBe(false);
    expect(
      new RepeatedProseGuard().append(
        Array.from({ length: 40 }, (_, i) => `${i}: ${paragraph}\n\n`).join(""),
      ),
    ).toBe(false);
  });
});
