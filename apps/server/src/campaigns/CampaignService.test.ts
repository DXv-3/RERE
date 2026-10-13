import * as StudioService from "./studio/StudioService.ts";
import { emptyStudio } from "./studio/StudioStore.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  CampaignCommand,
  type CampaignConnectionState,
  type CampaignCommand as Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CampaignConnection from "./CampaignConnection.ts";
import * as CampaignPublisher from "./CampaignPublisher.ts";
import * as CampaignService from "./CampaignService.ts";
import * as CampaignStore from "./CampaignStore.ts";
import * as CampaignThreadNotifier from "./CampaignThreadNotifier.ts";
import * as CampaignStorage from "./storage/CampaignStorage.ts";
import * as GenerationService from "./generation/GenerationService.ts";

const decode = Schema.decodeUnknownSync(CampaignCommand);
const state: CampaignConnectionState = {
  connector: "export",
  baseUrl: "",
  hasKey: false,
  publishing: "off",
  exportDirectory: "",
};

const storageState = {
  mode: "off",
  endpoint: "",
  region: "auto",
  bucket: "",
  publicBaseUrl: "",
  prefix: "campaigns/",
  hasCredentials: false,
} as const;

it.effect("asks for the owner's scope on everything except saving and submitting a post", () =>
  Effect.sync(() => {
    const draft = {
      campaignId: "c",
      platforms: ["facebook"],
      captions: { default: "x", byPlatform: {} },
      mediaPaths: [],
      mediaUrls: [],
    };
    const operate: Command[] = [
      decode({ command: "post.save", post: draft }),
      decode({ command: "post.submit", postId: "p" }),
    ];
    const owner: Command[] = [
      decode({
        command: "client.upsert",
        client: { name: "A", brandNotes: "", doNotSay: [], approvalMode: "auto-publish" },
      }),
      decode({ command: "client.delete", id: "c" }),
      decode({
        command: "campaign.upsert",
        campaign: { clientId: "c", name: "A", approvalMode: "auto-publish" },
      }),
      decode({ command: "campaign.delete", id: "c" }),
      decode({ command: "post.approve", postId: "p" }),
      decode({ command: "post.requestChanges", postId: "p", text: "no" }),
      decode({ command: "post.reject", postId: "p" }),
      decode({ command: "post.publishNow", postId: "p" }),
      decode({ command: "post.retry", postId: "p" }),
      decode({ command: "post.delete", postId: "p" }),
      decode({ command: "connection.set", connection: { baseUrl: "https://x.test" } }),
      decode({ command: "connection.test" }),
      decode({ command: "storage.set", storage: { mode: "off" } }),
      decode({ command: "storage.test" }),
      decode({ command: "post.uploadMedia", postId: "p" }),
      decode({ command: "post.revokeMedia", postId: "p" }),
      decode({ command: "storage.set", storage: { mode: "server" } }),
      // Starting a generation spends money, so it is the owner's call like every other spend.
      decode({
        command: "generation.start",
        kind: "image",
        clientId: "c",
        prompt: "a cake",
        options: {},
      }),
      decode({ command: "generation.approve", jobId: "j" }),
      decode({ command: "generation.cancel", jobId: "j" }),
      decode({ command: "generation.settings.set", settings: { imageGenerator: "local" } }),
      decode({ command: "generation.test", generator: "openrouter" }),
      // This computer's graphics card: video from a still, its model, and its check and download.
      decode({
        command: "generation.start",
        kind: "video",
        clientId: "c",
        prompt: "the barista hands over the cup",
        options: { firstFrameJobId: "j" },
      }),
      decode({
        command: "generation.settings.set",
        settings: { videoGenerator: "local-gpu", localGpuVideoModel: "wan22-ti2v-5b" },
      }),
      decode({ command: "generation.test", generator: "local-gpu", kind: "video" }),
      decode({
        command: "generation.test",
        generator: "local-gpu",
        action: "download",
        kind: "video",
      }),
    ];
    // No generation command is ever operate-scoped: the card and the spend are the owner's.
    assert.isTrue(owner.filter((command) => command.command.startsWith("generation.")).length >= 8);
    for (const command of operate) {
      assert.strictEqual(CampaignService.commandScope(command), AuthOrchestrationOperateScope);
    }
    for (const command of owner) {
      assert.strictEqual(
        CampaignService.commandScope(command),
        AuthAccessWriteScope,
        command.command,
      );
    }
  }),
);

it.effect("runs a person's commands, feeds the board, and looks at once on publish now", () =>
  Effect.gen(function* () {
    const ticks = yield* Ref.make(0);
    const notifier = Layer.succeed(
      CampaignThreadNotifier.CampaignThreadNotifier,
      CampaignThreadNotifier.CampaignThreadNotifier.of({ tell: () => Effect.void }),
    );
    const connection = Layer.succeed(
      CampaignConnection.CampaignConnection,
      CampaignConnection.CampaignConnection.of({
        get: Effect.succeed(state),
        set: () => Effect.succeed({ ...state, hasKey: true }),
        test: () => Effect.succeed({ ok: true }),
        active: Effect.die("unused"),
        publishingOn: Effect.succeed(false),
      }),
    );
    const publisher = Layer.succeed(
      CampaignPublisher.CampaignPublisher,
      CampaignPublisher.CampaignPublisher.of({
        tick: Ref.update(ticks, (n) => n + 1).pipe(Effect.as(0)),
        start: () => Effect.void,
      }),
    );
    const storage = Layer.succeed(
      CampaignStorage.CampaignStorage,
      CampaignStorage.CampaignStorage.of({
        get: Effect.succeed(storageState),
        set: (input) => Effect.succeed({ ...storageState, bucket: input.bucket ?? "" }),
        test: Effect.succeed({ ok: true }),
        uploadPostMedia: (id) => Effect.die(`unused ${id}`),
        revokePostMedia: (id) => Effect.die(`unused ${id}`),
        ensurePublicMedia: (post) => Effect.succeed(post),
      }),
    );
    const store = CampaignStore.layer.pipe(
      Layer.provide(notifier),
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const generation = Layer.mock(GenerationService.GenerationService)({
      board: () =>
        Effect.succeed({
          jobs: [],
          settings: {
            imageGenerator: "none",
            videoGenerator: "none",
            hasOpenRouterKey: false,
            hasMuapiKey: false,
            hasFalKey: false,
            localBaseUrl: "",
            localGpu: {
              python: "",
              model: "",
              videoModel: "",
              modelsDir: "",
              whenBusy: "fallback",
              windowStart: "",
              windowEnd: "",
            },
            models: { image: "", video: "", local: "" },
          },
          spend: [],
        }),
    });
    const layer = CampaignService.layer.pipe(
      Layer.provide(
        Layer.mock(StudioService.StudioService)({ get: (id) => Effect.succeed(emptyStudio(id)) }),
      ),
      Layer.provide(generation),
      Layer.provide(connection),
      Layer.provide(storage),
      Layer.provide(publisher),
      Layer.provideMerge(store),
    );

    yield* Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 9, 6, 12, 0, 0));
      const service = yield* CampaignService.CampaignService;
      const client = yield* service.run(
        decode({
          command: "client.upsert",
          client: { name: "Candid", brandNotes: "", doNotSay: [] },
        }),
      );
      assert.strictEqual(client.kind, "client");
      const clientId = client.kind === "client" ? client.client.id : "";
      const campaign = yield* service.run(
        decode({ command: "campaign.upsert", campaign: { clientId, name: "Reels" } }),
      );
      const campaignId = campaign.kind === "campaign" ? campaign.campaign.id : "";

      const saved = yield* service.run(
        decode({
          command: "post.save",
          post: {
            campaignId,
            platforms: ["facebook"],
            captions: { default: "Hello", byPlatform: {} },
            mediaPaths: [],
            mediaUrls: [],
          },
        }),
      );
      const postId = saved.kind === "post" ? saved.post.id : "";
      const submitted = yield* service.run(decode({ command: "post.submit", postId }));
      assert.strictEqual(submitted.kind === "post" ? submitted.post.status : "", "needs-approval");

      const first = yield* service
        .subscribeBoard(campaignId)
        .pipe(Stream.take(1), Stream.runCollect);
      const board = first[0];
      assert.strictEqual(board?.clients.length, 1);
      assert.deepStrictEqual(board?.campaigns[0]?.postCounts, { "needs-approval": 1 });
      assert.strictEqual(board?.posts[0]?.id, postId);
      assert.strictEqual(board?.connection.publishing, "off");
      assert.deepStrictEqual(board?.storage, storageState);
      assert.strictEqual(board?.generation.settings.imageGenerator, "none");

      const approved = yield* service.run(decode({ command: "post.publishNow", postId }));
      assert.strictEqual(approved.kind === "post" ? approved.post.status : "", "approved");
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(ticks), 1);

      const set = yield* service.run(
        decode({ command: "connection.set", connection: { baseUrl: "https://x.test" } }),
      );
      assert.strictEqual(set.kind === "connection" ? set.connection.hasKey : false, true);
      const storageSet = yield* service.run(
        decode({ command: "storage.set", storage: { bucket: "media" } }),
      );
      assert.strictEqual(storageSet.kind === "storage" ? storageSet.storage.bucket : "", "media");
      const storageTest = yield* service.run(decode({ command: "storage.test" }));
      assert.deepStrictEqual(storageTest, { kind: "storageTest", result: { ok: true } });
      const test = yield* service.run(decode({ command: "connection.test" }));
      assert.deepStrictEqual(test, { kind: "connectionTest", result: { ok: true } });

      const gone = yield* service.run(decode({ command: "post.delete", postId }));
      assert.deepStrictEqual(gone, { kind: "deleted", id: postId });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "requires owner scope for Studio spending and approval but allows creative preparation",
  () =>
    Effect.sync(() => {
      const studio = emptyStudio("c");
      const save = {
        command: "studio.save",
        campaignId: "c",
        expectedRevision: 0,
        brief: studio.brief,
        scenes: [],
      };
      for (const command of [
        save,
        { command: "studio.generate", campaignId: "c", expectedRevision: 0, sceneIds: ["one"] },
        { command: "studio.render", campaignId: "c", expectedRevision: 0, aspectRatio: "9:16" },
      ])
        assert.strictEqual(
          CampaignService.commandScope(decode(command)),
          AuthOrchestrationOperateScope,
        );
      for (const command of [
        { ...save, brief: { ...studio.brief, budgetUsd: 5 } },
        { ...save, brief: { ...studio.brief, budgetUsd: null } },
        { command: "studio.asset.approve", campaignId: "c", assetId: "a" },
        { command: "studio.render.approve", campaignId: "c", renderId: "r" },
        {
          command: "studio.narrate",
          campaignId: "c",
          expectedRevision: 0,
          text: "Hello",
          allowanceUsd: 1,
          requestId: "r",
        },
        {
          command: "studio.post",
          campaignId: "c",
          renderId: "r",
          platforms: ["instagram"],
          captions: { default: "Coffee", byPlatform: {} },
        },
        { command: "generation.reconcile", jobId: "j", providerJobId: "provider-j" },
      ])
        assert.strictEqual(CampaignService.commandScope(decode(command)), AuthAccessWriteScope);
    }),
);
