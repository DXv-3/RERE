import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { resolveModelShareEmailSettings } from "../Config.ts";

const all = {
  host: "mail.example.test",
  port: "465",
  user: "support@example.test",
  password: Redacted.make("secret"),
  from: "CodeWrench <support@example.test>",
};

describe("resolveModelShareEmailSettings", () => {
  it("turns mail on only with all five settings", () => {
    expect(resolveModelShareEmailSettings(all).settings).toMatchObject({
      host: "mail.example.test",
      port: 465,
      user: "support@example.test",
      from: "CodeWrench <support@example.test>",
    });
    for (const missing of ["host", "port", "user", "password", "from"] as const) {
      const result = resolveModelShareEmailSettings({ ...all, [missing]: undefined });
      expect(result.settings).toBeUndefined();
      expect(result.problem).toContain("missing");
    }
    expect(resolveModelShareEmailSettings({ ...all, host: "  " }).settings).toBeUndefined();
  });

  it("is quietly off when nothing is set, and refuses any port but 465 with a clear reason", () => {
    expect(
      resolveModelShareEmailSettings({
        host: undefined,
        port: undefined,
        user: undefined,
        password: undefined,
        from: undefined,
      }),
    ).toEqual({});
    for (const port of ["25", "587", "2465", "465x"]) {
      const result = resolveModelShareEmailSettings({ ...all, port });
      expect(result.settings).toBeUndefined();
      expect(result.problem).toContain("465");
    }
  });
});
