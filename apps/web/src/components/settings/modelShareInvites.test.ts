import type { ProviderInstanceConfig } from "@t3tools/contracts";
import type { RelayModelShareInviteOffer } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { parseModelShareCode, buildSharedModelInstance } from "./modelShareCode";
import { describeCollectedSharedModels, planSharedModelInvites } from "./modelShareInvites";

function invite(overrides: Partial<RelayModelShareInviteOffer> = {}): RelayModelShareInviteOffer {
  return {
    inviteId: "invite-1",
    label: "Ryan's MacBook",
    models: ["qwen38"],
    baseUrl: "https://home.example.test/api/model-share",
    token: "cwm_secret-token",
    createdAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("planSharedModelInvites", () => {
  it("adds a new share through the same code a pasted share would use", () => {
    const plan = planSharedModelInvites({ invites: [invite()], existingInstances: {} });
    expect(plan.add).toHaveLength(1);
    expect(plan.alreadyHave).toEqual([]);
    expect(plan.skipped).toEqual([]);
    const parsed = parseModelShareCode(plan.add[0]?.code ?? "");
    expect(parsed).toEqual({
      ok: true,
      access: {
        baseUrl: "https://home.example.test/api/model-share",
        token: "cwm_secret-token",
        models: ["qwen38"],
      },
    });
  });

  it("does not add a share this computer already has, however its models are ordered", () => {
    const existing = {
      claudeAgent_shared_qwen38: buildSharedModelInstance(
        {
          baseUrl: "https://home.example.test/api/model-share/",
          token: "cwm_old",
          models: ["b", "a"],
        },
        "Shared: b",
      ),
    };
    const plan = planSharedModelInvites({
      invites: [invite({ models: ["a", "b"] })],
      existingInstances: existing,
    });
    expect(plan.add).toEqual([]);
    expect(plan.alreadyHave.map((entry) => entry.inviteId)).toEqual(["invite-1"]);
  });

  it("adds a share that points elsewhere or serves other models", () => {
    const existing: Record<string, ProviderInstanceConfig> = {
      other: buildSharedModelInstance(
        {
          baseUrl: "https://elsewhere.example.test/api/model-share",
          token: "t",
          models: ["qwen38"],
        },
        "Other",
      ),
      mine: buildSharedModelInstance(
        { baseUrl: "https://home.example.test/api/model-share", token: "t", models: ["different"] },
        "Mine",
      ),
    };
    expect(
      planSharedModelInvites({ invites: [invite()], existingInstances: existing }).add,
    ).toHaveLength(1);
  });

  it("never adds the same share twice in one batch", () => {
    const plan = planSharedModelInvites({
      invites: [
        invite({ inviteId: "a" }),
        invite({ inviteId: "a" }),
        invite({ inviteId: "b", token: "cwm_other-token" }),
        invite({ inviteId: "c", models: ["second"] }),
      ],
      existingInstances: undefined,
    });
    expect(plan.add.map((entry) => entry.invite.inviteId)).toEqual(["a", "c"]);
    expect(plan.alreadyHave.map((entry) => entry.inviteId)).toEqual(["a", "b"]);
  });

  it("ignores invites that are not https or cannot be read, and leaves them waiting", () => {
    const plan = planSharedModelInvites({
      invites: [
        invite({ inviteId: "http", baseUrl: "http://home.example.test/api/model-share" }),
        invite({ inviteId: "lan", baseUrl: "http://192.168.1.4:3773/api/model-share" }),
        invite({ inviteId: "nonsense", baseUrl: "not a url" }),
        invite({ inviteId: "other-path", baseUrl: "https://home.example.test/somewhere" }),
        invite({ inviteId: "bad-token", token: "has space" }),
        invite({ inviteId: "no-models", models: [] }),
      ],
      existingInstances: {},
    });
    expect(plan.add).toEqual([]);
    expect(plan.alreadyHave).toEqual([]);
    expect(plan.skipped.map((entry) => entry.inviteId)).toEqual([
      "http",
      "lan",
      "nonsense",
      "other-path",
      "bad-token",
      "no-models",
    ]);
  });
});

describe("describeCollectedSharedModels", () => {
  it("says nothing when nothing was added", () => {
    expect(describeCollectedSharedModels([])).toBeNull();
  });

  it("names who shared which model", () => {
    expect(describeCollectedSharedModels([{ label: "Ryan", models: ["qwen38"] }])).toBe(
      "Ryan shared qwen38 with you. It is in your model list.",
    );
    expect(describeCollectedSharedModels([{ label: "Ryan", models: ["a", "b"] }])).toBe(
      "Ryan shared 2 models with you. They are in your model list.",
    );
    expect(
      describeCollectedSharedModels([
        { label: "Ryan", models: ["a"] },
        { label: "Sam", models: ["b"] },
      ]),
    ).toBe("2 people shared models with you. They are in your model list.");
  });
});
