import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveStartModelSelection } from "./startThreadFromText";

const provider = (id: string, overrides: { enabled?: boolean; isAvailable?: boolean } = {}) => ({
  instanceId: ProviderInstanceId.make(id),
  enabled: true,
  isAvailable: true,
  models: [
    { slug: `${id}-small`, isDefault: false },
    { slug: `${id}-main`, isDefault: true },
  ],
  ...overrides,
});

describe("resolveStartModelSelection", () => {
  it("uses the configured default model when there is one", () => {
    const configured = { instanceId: ProviderInstanceId.make("codex"), model: "chosen" };
    expect(resolveStartModelSelection(configured, [provider("claude")])).toBe(configured);
  });

  it("falls back to the first usable provider's default model", () => {
    expect(
      resolveStartModelSelection(null, [
        provider("off", { enabled: false }),
        provider("missing", { isAvailable: false }),
        provider("claude"),
      ]),
    ).toEqual({ instanceId: ProviderInstanceId.make("claude"), model: "claude-main" });
  });

  it("has no answer when nothing can run", () => {
    expect(resolveStartModelSelection(undefined, [])).toBeNull();
  });
});
