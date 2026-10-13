import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { JevConnectionInput } from "./routing.ts";

describe("Jev credential transport", () => {
  it("round-trips the connect command while keeping the decoded key redacted", () => {
    const input = Schema.decodeUnknownSync(JevConnectionInput)({
      action: "connect",
      key: "test-private-key",
    });
    expect(input.action).toBe("connect");
    if (input.action !== "connect") throw new Error("Expected connect");
    expect(Redacted.value(input.key)).toBe("test-private-key");
    expect(JSON.stringify(input)).not.toContain("test-private-key");
    expect(Schema.encodeSync(JevConnectionInput)(input)).toEqual({
      action: "connect",
      key: "test-private-key",
    });
  });
  it("requires a key for connect and accepts a keyless disconnect", () => {
    expect(() => Schema.decodeUnknownSync(JevConnectionInput)({ action: "connect" })).toThrow();
    expect(Schema.decodeUnknownSync(JevConnectionInput)({ action: "disconnect" })).toEqual({
      action: "disconnect",
    });
  });
});
