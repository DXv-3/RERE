import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  inspectQualification,
  qualificationBinding,
  type QualificationEvidence,
} from "./qualificationPolicy.ts";
const now = Date.parse("2026-10-03T10:00:00Z");
const stamp = DateTime.formatIso(DateTime.makeUnsafe(now));
const id = ProviderInstanceId.make("account-a");
const selection: ModelSelection = {
  instanceId: id,
  model: "verified-model",
  options: [{ id: "effort", value: "medium" }],
};
const provider: ServerProvider = {
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  version: "1",
  auth: { status: "authenticated", profileId: "private-account" },
  checkedAt: stamp,
  models: [{ slug: "verified-model", name: "Model", isCustom: false, capabilities: null }],
  skills: [],
  slashCommands: [],
  usageLimits: {
    checkedAt: stamp,
    windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 20 }],
  },
};
const config = { home: "/private/provider-home" };
const binding = qualificationBinding(provider, selection, config)!;
const evidence: QualificationEvidence = {
  checkedAt: stamp,
  executionPath: "provider_harness",
  resolvedModel: selection.model,
  priceCheckedAt: stamp,
  catalogReceipt: "catalog-1",
  toolReceipt: "tool-1",
  capabilityReceipt: "eval-1",
  contextTokens: 32000,
  billing: "subscription",
  billingReceipt: "billing-1",
  inputMicroUsdPerMillion: null,
  outputMicroUsdPerMillion: null,
  requestMicroUsd: null,
  spendingGuardReceipt: "overage-off-1",
};
const inspect = (
  changes: Partial<QualificationEvidence> = {},
  providers: readonly ServerProvider[] = [provider],
) =>
  inspectQualification({
    providers,
    selection,
    binding,
    stored: { binding, evidence: { ...evidence, ...changes } },
    now,
  });
describe("model qualification policy", () => {
  it("distinguishes current evidence from permission to dispatch and never exposes identity", () => {
    const result = inspect();
    expect(result.state).toBe("evidence_ready");
    expect(result.automaticExecution).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private-account");
    expect(JSON.stringify(result)).not.toContain("private/provider-home");
  });
  it.each([
    [{ toolReceipt: null }, "tools_unverified"],
    [{ capabilityReceipt: null }, "capability_unverified"],
    [{ contextTokens: null }, "context_unverified"],
    [{ billingReceipt: null }, "billing_unverified"],
    [{ spendingGuardReceipt: null }, "spending_guard_unverified"],
    [{ billing: "metered" }, "paid_execution_disabled"],
    [{ billing: "unknown" }, "billing_unverified"],
    [{ checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 86400001)) }, "evidence_stale"],
    [{ checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)) }, "evidence_stale"],
  ] as const)("blocks incomplete or stale evidence %j", (changes, reason) => {
    expect(inspect(changes).reasons).toContain(reason);
  });
  it("requires every free price and a spending guard, never a missing-price zero default", () => {
    expect(inspect({ billing: "free" }).reasons).toContain("billing_unverified");
    expect(
      inspect({
        billing: "free",
        inputMicroUsdPerMillion: 0,
        outputMicroUsdPerMillion: 0,
        requestMicroUsd: 1,
      }).reasons,
    ).toContain("billing_unverified");
    expect(
      inspect({
        billing: "free",
        inputMicroUsdPerMillion: 0,
        outputMicroUsdPerMillion: 0,
        requestMicroUsd: 0,
      }).state,
    ).toBe("evidence_ready");
  });
  it("does not promote direct API receipts or changing router aliases to a coding route", () => {
    expect(inspect({ executionPath: "direct_api" }).reasons).toContain("harness_unverified");
    expect(inspect({ resolvedModel: "different-backend" }).reasons).toContain(
      "model_resolution_unverified",
    );
    const { executionPath: _path, resolvedModel: _model, ...legacy } = evidence;
    const result = inspectQualification({
      providers: [provider],
      selection,
      binding,
      stored: { binding, evidence: legacy },
      now,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(["harness_unverified", "model_resolution_unverified"]),
    );
    expect(result.state).toBe("blocked");
  });
  it("requires fresh free-price evidence independently of capability evidence", () => {
    const free = {
      billing: "free" as const,
      inputMicroUsdPerMillion: 0,
      outputMicroUsdPerMillion: 0,
      requestMicroUsd: 0,
    };
    for (const time of [now - 300001, now + 1])
      expect(
        inspect({ ...free, priceCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(time)) }).reasons,
      ).toContain("price_stale");
    expect(
      inspect({ ...free, priceCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 300000)) })
        .state,
    ).toBe("evidence_ready");
    const { priceCheckedAt: _price, ...legacy } = { ...evidence, ...free };
    expect(
      inspectQualification({
        providers: [provider],
        selection,
        binding,
        stored: { binding, evidence: legacy },
        now,
      }).reasons,
    ).toContain("price_stale");
  });
  it("checks all subscription windows and stale quota instead of the advertised plan", () => {
    const exhausted = {
      ...provider,
      usageLimits: {
        checkedAt: stamp,
        windows: [
          ...provider.usageLimits!.windows,
          { id: "session", kind: "session" as const, label: "Session", usedPercent: 100 },
        ],
      },
    };
    expect(inspect({}, [exhausted]).reasons).toContain("quota_unavailable");
    expect(
      inspect({}, [
        {
          ...provider,
          usageLimits: {
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now - 300001)),
            windows: provider.usageLimits!.windows,
          },
        },
      ]).reasons,
    ).toContain("quota_unavailable");
  });
  it("binds to account, instance, configuration, runtime and exact model options", () => {
    for (const [p, s, c] of [
      [
        { ...provider, auth: { status: "authenticated" as const, profileId: "another" } },
        selection,
        config,
      ],
      [{ ...provider, version: "2" }, selection, config],
      [provider, { ...selection, options: [{ id: "effort", value: "high" }] }, config],
      [provider, selection, { home: "/other" }],
    ] as const)
      expect(qualificationBinding(p, s, c)).not.toBe(binding);
    expect(
      qualificationBinding(
        provider,
        { ...selection, instanceId: ProviderInstanceId.make("account-b") },
        config,
      ),
    ).toBeNull();
    const result = inspectQualification({
      providers: [provider],
      selection,
      binding: "changed",
      stored: { binding, evidence },
      now,
    });
    expect(result.reasons).toContain("binding_changed");
    expect(result.contextTokens).toBeNull();
  });
  it("blocks unavailable models, uncertain identities and future provider snapshots", () => {
    expect(
      qualificationBinding({ ...provider, auth: { status: "unknown" } }, selection, config),
    ).toBeNull();
    const result = inspectQualification({
      providers: [
        { ...provider, checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1)), models: [] },
      ],
      selection,
      binding: null,
      stored: null,
      now,
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(["snapshot_stale", "model_unavailable", "evidence_missing"]),
    );
  });
});
