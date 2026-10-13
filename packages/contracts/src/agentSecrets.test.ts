import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSecretRequestProvideInput, AgentSecretSetInput } from "./agentSecrets.ts";

const VALUE = "sk_live_wire-needle-31";
const setCodec = Schema.toCodecJson(AgentSecretSetInput);
const provideCodec = Schema.toCodecJson(AgentSecretRequestProvideInput);
const decodeSet = Schema.decodeUnknownSync(setCodec);
const encodeSet = Schema.encodeUnknownSync(setCodec);
const decodeProvide = Schema.decodeUnknownSync(provideCodec);
const encodeProvide = Schema.encodeUnknownSync(provideCodec);

// The RPC layer serialises payloads through `Schema.toCodecJson`, so these are the real wire shapes.
describe("secret value payloads", () => {
  it("travel as a plain string and arrive as a Redacted that prints as redacted", () => {
    const wire = {
      agentId: "agent-a",
      name: "STRIPE_API_KEY",
      label: "Stripe",
      kind: "api_key",
      value: VALUE,
    };
    const decoded = decodeSet(wire);
    expect(Redacted.isRedacted(decoded.value)).toBe(true);
    expect(Redacted.value(decoded.value)).toBe(VALUE);
    expect(String(decoded.value)).not.toContain(VALUE);
    expect(JSON.stringify(decoded)).not.toContain(VALUE);
    // The client side: a Redacted goes in, the string comes out on the wire.
    expect(encodeSet({ ...decoded, value: Redacted.make(VALUE) })).toEqual(wire);

    const provided = decodeProvide({ requestId: "secretreq:1", value: VALUE });
    expect(JSON.stringify(provided)).not.toContain(VALUE);
    expect(encodeProvide({ requestId: "secretreq:1", value: Redacted.make(VALUE) })).toEqual({
      requestId: "secretreq:1",
      value: VALUE,
    });
  });

  it("a payload that fails to decode does not quote the value", () => {
    let message = "";
    try {
      decodeSet({
        agentId: "agent-a",
        name: "lower case",
        label: "Stripe",
        kind: "api_key",
        value: VALUE,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(VALUE);
  });
});
