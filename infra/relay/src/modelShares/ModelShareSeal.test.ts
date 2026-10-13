import { describe, expect, it } from "vite-plus/test";
import * as Redacted from "effect/Redacted";

import { openModelShareToken, sealModelShareToken } from "./ModelShareSeal.ts";

const secret = Redacted.make("seal-secret-a");
const token = "cwm_example-token";

describe("model share token sealing", () => {
  it("round-trips and never stores the token in the clear", async () => {
    const sealed = await sealModelShareToken({ secret, token, context: "invite-1|a@example.com" });
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith("v1.")).toBe(true);
    await expect(
      openModelShareToken({ secret, sealed, context: "invite-1|a@example.com" }),
    ).resolves.toBe(token);
  });

  it("uses a fresh nonce each time", async () => {
    const context = "invite-1|a@example.com";
    const first = await sealModelShareToken({ secret, token, context });
    const second = await sealModelShareToken({ secret, token, context });
    expect(first).not.toBe(second);
  });

  it("does not open for another invite, another recipient, another key, or damaged input", async () => {
    const sealed = await sealModelShareToken({ secret, token, context: "invite-1|a@example.com" });
    await expect(
      openModelShareToken({ secret, sealed, context: "invite-2|a@example.com" }),
    ).resolves.toBeNull();
    await expect(
      openModelShareToken({ secret, sealed, context: "invite-1|b@example.com" }),
    ).resolves.toBeNull();
    await expect(
      openModelShareToken({
        secret: Redacted.make("seal-secret-b"),
        sealed,
        context: "invite-1|a@example.com",
      }),
    ).resolves.toBeNull();
    await expect(
      openModelShareToken({ secret, sealed: `${sealed}x`, context: "invite-1|a@example.com" }),
    ).resolves.toBeNull();
    await expect(
      openModelShareToken({ secret, sealed: "", context: "invite-1|a@example.com" }),
    ).resolves.toBeNull();
  });
});
