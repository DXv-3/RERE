import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { pinSharedModel, readShareToken, sharedModelList } from "./ModelShareProxy.ts";
import * as ModelShareInviteRelay from "./ModelShareInviteRelay.ts";
import * as ModelShares from "./ModelShares.ts";

const gateway = (overrides: Record<string, unknown> = {}) => ({
  driver: "claudeAgent",
  enabled: true,
  environment: [
    { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:4017/", sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "gateway-key", sensitive: false },
  ],
  config: { customModels: ["qwen38", "qwen38-think"] },
  ...overrides,
});

/** A relay that records what the share asked of it, standing in for the real one. */
function makeFakeRelay(options?: { readonly signedIn?: boolean; readonly emailed?: boolean }) {
  const created: Array<{
    readonly shareId: string;
    readonly recipientEmail: string;
    readonly token: string;
  }> = [];
  const revoked: Array<string> = [];
  const accepted = new Set<string>();
  const layer = Layer.succeed(ModelShareInviteRelay.ModelShareInviteRelay, {
    create: (input) =>
      options?.signedIn === false
        ? Effect.fail(
            new ModelShareInviteRelay.ModelShareInviteFailedError({ reason: "sign_in_required" }),
          )
        : Effect.sync(() => {
            created.push(input);
            return { inviteId: `invite-${created.length}`, emailed: options?.emailed === true };
          }),
    revoke: (inviteId) => Effect.sync(() => void revoked.push(inviteId)),
    statuses: Effect.sync(() =>
      created.map((invite, index) => ({
        inviteId: `invite-${index + 1}`,
        shareId: invite.shareId,
        recipientEmail: invite.recipientEmail,
        createdAt: "2026-10-06T00:00:00.000Z",
        acceptedAt: accepted.has(`invite-${index + 1}`) ? "2026-10-06T01:00:00.000Z" : null,
      })),
    ),
  });
  return { created, revoked, accepted, layer };
}

const makeLayer = (
  providerInstances: Record<string, unknown>,
  relay: Layer.Layer<ModelShareInviteRelay.ModelShareInviteRelay> = makeFakeRelay().layer,
) =>
  ModelShares.layer.pipe(
    Layer.provide(relay),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ProcessRunner.layer),
    Layer.provide(ServerSettings.layerTest({ providerInstances } as never)),
  );

it.layer(NodeServices.layer)("ModelShares", (it) => {
  it.effect("gives a token that reaches the shared provider and nothing reveals it later", () =>
    Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const { share, token } = yield* shares.create({
        label: "Sam",
        providerInstanceId: "local",
      });

      expect(share.models).toEqual(["qwen38", "qwen38-think"]);
      expect((yield* shares.list).flatMap((listed) => Object.values(listed))).not.toContain(token);

      const authorized = Option.getOrThrow(yield* shares.authorize(token));
      expect(authorized.id).toBe(share.id);
      expect(yield* shares.resolveUpstream(authorized)).toEqual({
        baseUrl: "http://127.0.0.1:4017",
        headers: { authorization: "Bearer gateway-key" },
      });
      expect(Option.getOrThrow(yield* shares.authorize(token)).lastUsedAt).not.toBeNull();
    }).pipe(Effect.provide(makeLayer({ local: gateway() }))),
  );

  it.effect("turns away unknown tokens, pairing-style tokens and revoked shares", () =>
    Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const { share, token } = yield* shares.create({
        label: "Sam",
        providerInstanceId: "local",
        models: ["qwen38"],
      });

      expect(Option.isNone(yield* shares.authorize(`${token}x`))).toBe(true);
      expect(Option.isNone(yield* shares.authorize("ABCDEFGHJKLM"))).toBe(true);
      expect(Option.isNone(yield* shares.authorize(""))).toBe(true);

      expect(yield* shares.revoke(share.id)).toBe(true);
      expect(yield* shares.revoke(share.id)).toBe(false);
      expect(Option.isNone(yield* shares.authorize(token))).toBe(true);
      expect(yield* shares.list).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ local: gateway() }))),
  );

  it.effect("refuses to share a subscription, another driver, or a model the provider lacks", () =>
    Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const refusal = (providerInstanceId: string, models?: ReadonlyArray<string>) =>
        shares.create({ label: "Sam", providerInstanceId, ...(models ? { models } : {}) }).pipe(
          Effect.flip,
          Effect.map((error) => (error._tag === "ModelShareRefusedError" ? error.reason : error)),
        );

      expect(yield* refusal("claudeAgent")).toBe("provider_uses_anthropic");
      expect(yield* refusal("codex")).toBe("not_a_claude_provider");
      expect(yield* refusal("missing")).toBe("unknown_provider");
      expect(yield* refusal("off")).toBe("provider_disabled");
      expect(yield* refusal("bare")).toBe("no_models");
      expect(yield* refusal("local", ["claude-opus-5-5"])).toBe("model_not_served");
      expect(yield* shares.list).toEqual([]);
    }).pipe(
      Effect.provide(
        makeLayer({
          local: gateway(),
          claudeAgent: { driver: "claudeAgent", enabled: true },
          codex: { driver: "codex", enabled: true },
          off: gateway({ enabled: false }),
          bare: gateway({ config: {} }),
        }),
      ),
    ),
  );

  it.effect("stops serving a share once its provider is no longer shareable", () =>
    Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const error = yield* Effect.flip(
        shares.resolveUpstream({
          id: "share",
          label: "Sam",
          providerInstanceId: "removed",
          models: ["qwen38"],
          createdAt: "2026-10-06T00:00:00.000Z",
          lastUsedAt: null,
        }),
      );
      expect(error._tag).toBe("ModelShareUpstreamUnavailableError");
    }).pipe(Effect.provide(makeLayer({ local: gateway() }))),
  );

  it.effect(
    "shares by email: offers an invitation, lists whether it was collected, and takes it back on revoke",
    () => {
      const relay = makeFakeRelay();
      return Effect.gen(function* () {
        const shares = yield* ModelShares.ModelShares;
        const { share, token } = yield* shares.create({
          label: "Sam",
          providerInstanceId: "local",
          recipientEmail: "  Sam@Example.com ",
        });

        expect(share.recipientEmail).toBe("sam@example.com");
        expect(relay.created).toEqual([
          {
            shareId: share.id,
            recipientEmail: "sam@example.com",
            models: ["qwen38", "qwen38-think"],
            token,
          },
        ]);
        // The share code still works the same way.
        expect(Option.isSome(yield* shares.authorize(token))).toBe(true);

        expect((yield* shares.list)[0]).toMatchObject({
          recipientEmail: "sam@example.com",
          inviteAcceptedAt: null,
        });
        relay.accepted.add("invite-1");
        expect((yield* shares.list)[0]?.inviteAcceptedAt).toBe("2026-10-06T01:00:00.000Z");

        expect(yield* shares.revoke(share.id)).toBe(true);
        expect(relay.revoked).toEqual(["invite-1"]);
        expect(Option.isNone(yield* shares.authorize(token))).toBe(true);
      }).pipe(Effect.provide(makeLayer({ local: gateway() }, relay.layer)));
    },
  );

  it.effect("passes on whether the relay emailed the recipient, and says nothing otherwise", () => {
    const emailing = makeFakeRelay({ emailed: true });
    const input = {
      label: "Sam",
      providerInstanceId: "local",
      recipientEmail: "sam@example.com",
    } as const;
    return Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      expect((yield* shares.create(input)).emailed).toBe(true);
      // Sharing by code alone never asks the relay, so nothing was emailed.
      const byCode = yield* shares.create({ label: "Sam", providerInstanceId: "local" });
      expect("emailed" in byCode).toBe(false);
    }).pipe(
      Effect.provide(makeLayer({ local: gateway() }, emailing.layer)),
      Effect.andThen(
        Effect.gen(function* () {
          const shares = yield* ModelShares.ModelShares;
          const created = yield* shares.create(input);
          expect("emailed" in created).toBe(false);
        }).pipe(Effect.provide(makeLayer({ local: gateway() }, makeFakeRelay().layer))),
      ),
    );
  });

  it.effect("creates nothing when this machine cannot send the invitation", () => {
    const relay = makeFakeRelay({ signedIn: false });
    return Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const error = yield* Effect.flip(
        shares.create({
          label: "Sam",
          providerInstanceId: "local",
          recipientEmail: "sam@example.com",
        }),
      );
      expect(error).toMatchObject({
        _tag: "ModelShareInviteFailedError",
        reason: "sign_in_required",
      });
      expect(error.message).toBe(
        "Sign in on this machine first to share by email. A share code still works.",
      );
      expect(yield* shares.list).toEqual([]);

      // Without an email, a machine that is not signed in shares by code as before.
      const { share } = yield* shares.create({ label: "Sam", providerInstanceId: "local" });
      expect(share.recipientEmail).toBeUndefined();
      expect(yield* shares.list).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer({ local: gateway() }, relay.layer)));
  });

  it.effect("refuses a malformed email before asking the relay", () => {
    const relay = makeFakeRelay();
    return Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      for (const recipientEmail of ["sam", "sam@", "a b@c.com", "a@b"]) {
        const error = yield* Effect.flip(
          shares.create({ label: "Sam", providerInstanceId: "local", recipientEmail }),
        );
        expect(error).toMatchObject({
          _tag: "ModelShareInviteFailedError",
          reason: "email_invalid",
        });
      }
      expect(relay.created).toEqual([]);
      expect(yield* shares.list).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ local: gateway() }, relay.layer)));
  });

  it.effect("still lists and revokes shares when the relay is away", () => {
    const relay = makeFakeRelay();
    const away = Layer.succeed(ModelShareInviteRelay.ModelShareInviteRelay, {
      create: (input) =>
        Effect.sync(() => (relay.created.push(input), { inviteId: "invite-1", emailed: false })),
      revoke: () =>
        Effect.fail(
          new ModelShareInviteRelay.ModelShareInviteFailedError({ reason: "unreachable" }),
        ),
      statuses: Effect.fail(
        new ModelShareInviteRelay.ModelShareInviteFailedError({ reason: "unreachable" }),
      ),
    });
    return Effect.gen(function* () {
      const shares = yield* ModelShares.ModelShares;
      const { share, token } = yield* shares.create({
        label: "Sam",
        providerInstanceId: "local",
        recipientEmail: "sam@example.com",
      });
      expect((yield* shares.list)[0]).toMatchObject({ inviteAcceptedAt: null });
      // The token stops working here even though the invitation could not be taken back.
      expect(yield* shares.revoke(share.id)).toBe(true);
      expect(Option.isNone(yield* shares.authorize(token))).toBe(true);
    }).pipe(Effect.provide(makeLayer({ local: gateway() }, away)));
  });

  it.effect("reads the gateway key the way the Claude CLI does when the instance holds none", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "model-share-home-" });
      yield* fileSystem.writeFileString(
        path.join(home, "settings.json"),
        '{"apiKeyHelper":"printf helper-key"}',
      );
      const upstream = yield* Effect.gen(function* () {
        const shares = yield* ModelShares.ModelShares;
        const { share } = yield* shares.create({ label: "Sam", providerInstanceId: "local" });
        return yield* shares.resolveUpstream(share);
      }).pipe(
        Effect.provide(
          makeLayer({
            local: gateway({
              environment: [
                { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:4017", sensitive: false },
              ],
              config: { customModels: ["qwen38"], homePath: home },
            }),
          }),
        ),
      );
      expect(upstream.headers).toEqual({
        authorization: "Bearer helper-key",
        "x-api-key": "helper-key",
      });
    }),
  );
});

it("reads the share token from either header a Claude client sends", () => {
  expect(readShareToken({ authorization: "Bearer cwm_abc" })).toBe("cwm_abc");
  expect(readShareToken({ "x-api-key": " cwm_abc " })).toBe("cwm_abc");
  expect(readShareToken({ authorization: "Basic abc" })).toBe("");
  expect(readShareToken({})).toBe("");
});

it("keeps a shared model and answers any other with the share's first model", () => {
  const models = ["qwen38", "qwen38-think"];
  const thinking = JSON.stringify({ model: "qwen38-think", max_tokens: 5 });
  expect(pinSharedModel(thinking, models)).toBe(thinking);
  expect(
    JSON.parse(
      pinSharedModel(JSON.stringify({ model: "claude-haiku-4-5", stream: true }), models)!,
    ),
  ).toEqual({ model: "qwen38", stream: true });
  expect(JSON.parse(pinSharedModel("{}", models)!)).toEqual({ model: "qwen38" });
  expect(pinSharedModel("[]", models)).toBeNull();
  expect(pinSharedModel("not json", models)).toBeNull();
  expect(pinSharedModel(thinking, [])).toBeNull();
});

it("lists only the share's models for discovery", () => {
  const list = sharedModelList({ models: ["qwen38"], createdAt: "2026-10-06T00:00:00.000Z" });
  expect(list.data.map((model) => model.id)).toEqual(["qwen38"]);
  expect(list.has_more).toBe(false);
});
