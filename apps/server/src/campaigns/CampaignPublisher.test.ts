import { assert, it } from "@effect/vitest";
import {
  CampaignError,
  ThreadId,
  type CampaignApprovalMode,
  type CampaignPlatform,
  type CampaignPost,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CampaignConnection from "./CampaignConnection.ts";
import * as CampaignPublisher from "./CampaignPublisher.ts";
import * as CampaignStore from "./CampaignStore.ts";
import * as CampaignThreadNotifier from "./CampaignThreadNotifier.ts";
import * as CampaignStorage from "./storage/CampaignStorage.ts";
import type { PublishOutcome, PublishingConnector } from "./publishing/PublishingConnector.ts";

const threadId = ThreadId.make("thread-agent");
const agent = { kind: "agent", threadId } as const;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

interface World {
  readonly publishing: Ref.Ref<boolean>;
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  readonly told: Ref.Ref<ReadonlyArray<{ readonly threadId: string; readonly text: string }>>;
  /** What the fake connector answers for a platform; absent means success. */
  readonly answers: Ref.Ref<Partial<Record<CampaignPlatform, PublishOutcome>>>;
  /** What the fake cloud storage does for a post with files that have no links. */
  readonly upload: Ref.Ref<(post: CampaignPost) => Effect.Effect<CampaignPost, CampaignError>>;
  /** The posts the fake connector was asked to send, as it saw them. */
  readonly seenPosts: Ref.Ref<ReadonlyArray<CampaignPost>>;
}

const makeLayer = (world: World, kind: PublishingConnector["kind"]) => {
  const connector: PublishingConnector = {
    kind,
    publish: ({ platform, post }) =>
      Effect.gen(function* () {
        yield* Ref.update(world.sent, (all) => [...all, platform]);
        yield* Ref.update(world.seenPosts, (all) => [...all, post]);
        const answers = yield* Ref.get(world.answers);
        return (
          answers[platform] ?? {
            success: true,
            postId: `${platform}-1`,
            link: `https://x.test/${platform}`,
          }
        );
      }),
    schedule: () => Effect.succeed({ success: true }),
    autopostState: () => Effect.succeed({ kind: "known", paused: false, masterEnabled: true }),
    test: () => Effect.succeed({ ok: true }),
  };
  const connection = Layer.succeed(
    CampaignConnection.CampaignConnection,
    CampaignConnection.CampaignConnection.of({
      get: Effect.die("unused"),
      set: () => Effect.die("unused"),
      test: () => Effect.die("unused"),
      active: Effect.succeed(connector),
      publishingOn: Ref.get(world.publishing),
    }),
  );
  const notifier = Layer.succeed(
    CampaignThreadNotifier.CampaignThreadNotifier,
    CampaignThreadNotifier.CampaignThreadNotifier.of({
      tell: (input) => Ref.update(world.told, (all) => [...all, input]),
    }),
  );
  const storage = Layer.succeed(
    CampaignStorage.CampaignStorage,
    CampaignStorage.CampaignStorage.of({
      get: Effect.die("unused"),
      set: () => Effect.die("unused"),
      test: Effect.die("unused"),
      uploadPostMedia: () => Effect.die("unused"),
      revokePostMedia: () => Effect.die("unused"),
      ensurePublicMedia: (post) => Ref.get(world.upload).pipe(Effect.flatMap((fn) => fn(post))),
    }),
  );
  const store = CampaignStore.layer.pipe(
    Layer.provide(notifier),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  return CampaignPublisher.layer.pipe(
    Layer.provide(connection),
    Layer.provide(notifier),
    Layer.provide(storage),
    Layer.provideMerge(store),
  );
};

const run = <A, E>(
  publishing: boolean,
  body: (
    world: World,
  ) => Effect.Effect<A, E, CampaignPublisher.CampaignPublisher | CampaignStore.CampaignStore>,
  kind: PublishingConnector["kind"] = "export",
) =>
  Effect.gen(function* () {
    const world: World = {
      publishing: yield* Ref.make(publishing),
      sent: yield* Ref.make<ReadonlyArray<string>>([]),
      told: yield* Ref.make<ReadonlyArray<{ readonly threadId: string; readonly text: string }>>(
        [],
      ),
      answers: yield* Ref.make<Partial<Record<CampaignPlatform, PublishOutcome>>>({}),
      upload: yield* Ref.make<(post: CampaignPost) => Effect.Effect<CampaignPost, CampaignError>>(
        (post) => Effect.succeed(post),
      ),
      seenPosts: yield* Ref.make<ReadonlyArray<CampaignPost>>([]),
    };
    return yield* body(world).pipe(Effect.provide(makeLayer(world, kind)));
  });

/** A client in `mode` with one campaign and one post the agent has already submitted. */
const readyPost = (
  mode: CampaignApprovalMode,
  options: {
    readonly platforms?: ReadonlyArray<CampaignPlatform>;
    readonly scheduledAt?: string;
    readonly mediaPaths?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const store = yield* CampaignStore.CampaignStore;
    const client = yield* store.upsertClient({
      name: "Candid",
      brandNotes: "",
      doNotSay: [],
      approvalMode: mode,
    });
    const campaign = yield* store.upsertCampaign({ clientId: client.id, name: "Reels" });
    const draft = yield* store.savePost(agent, {
      campaignId: campaign.id,
      platforms: options.platforms ?? ["facebook", "linkedin"],
      captions: { default: "Words", byPlatform: {} },
      mediaPaths: options.mediaPaths ?? [],
      mediaUrls: [],
      ...(options.scheduledAt === undefined ? {} : { scheduledAt: options.scheduledAt }),
    });
    const submitted = yield* store.submitPost(agent, draft.id);
    return { store, post: submitted };
  });

it.effect("sends nothing to any connector while publishing is off", () =>
  run(false, (world) =>
    Effect.gen(function* () {
      const { store, post } = yield* readyPost("auto-publish");
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      assert.strictEqual(yield* publisher.tick, 0);
      assert.deepStrictEqual(yield* Ref.get(world.sent), []);
      assert.strictEqual((yield* store.getPost(post.id)).status, "approved");
    }),
  ),
);

it.effect("posts a due post to every platform and records results, links and the log", () =>
  run(true, (world) =>
    Effect.gen(function* () {
      const { store, post } = yield* readyPost("auto-publish");
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      assert.strictEqual(yield* publisher.tick, 1);
      assert.deepStrictEqual(yield* Ref.get(world.sent), ["facebook", "linkedin"]);
      const done = yield* store.getPost(post.id);
      assert.strictEqual(done.status, "posted");
      assert.strictEqual(done.publishResults.facebook?.link, "https://x.test/facebook");
      assert.strictEqual((yield* store.publishLog(post.id)).length, 2);
      // Nothing is left to do, and nothing is sent twice.
      assert.strictEqual(yield* publisher.tick, 0);
      assert.deepStrictEqual(yield* Ref.get(world.sent), ["facebook", "linkedin"]);
      // Auto publish reports nothing beyond the log.
      assert.deepStrictEqual(yield* Ref.get(world.told), []);
    }),
  ),
);

it.effect("holds a scheduled post until its time", () =>
  run(true, (world) =>
    Effect.gen(function* () {
      const { store, post } = yield* readyPost("auto-publish", {
        scheduledAt: "2026-10-06T13:00:00.000Z",
      });
      assert.strictEqual(post.status, "scheduled");
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      assert.strictEqual(yield* publisher.tick, 0);
      yield* TestClock.setTime(Date.UTC(2026, 9, 6, 13, 0, 1));
      assert.strictEqual(yield* publisher.tick, 1);
      assert.strictEqual((yield* store.getPost(post.id)).status, "posted");
      assert.lengthOf(yield* Ref.get(world.sent), 2);
    }),
  ),
);

it.effect("keeps the platform that worked and retries only the one that failed", () =>
  run(true, (world) =>
    Effect.gen(function* () {
      const { store, post } = yield* readyPost("ask-first");
      // Under ask-first nothing is due until a person approves.
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      assert.strictEqual(yield* publisher.tick, 0);
      yield* store.approvePost({ postId: post.id });
      yield* Ref.set(world.answers, { linkedin: { success: false, error: "Token expired" } });
      assert.strictEqual(yield* publisher.tick, 1);
      const failed = yield* store.getPost(post.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.publishResults.linkedin?.error, "Token expired");

      yield* Ref.set(world.answers, {});
      yield* Ref.set(world.sent, []);
      yield* store.retryPost(post.id);
      assert.strictEqual(yield* publisher.tick, 1);
      assert.deepStrictEqual(yield* Ref.get(world.sent), ["linkedin"]);
      assert.strictEqual((yield* store.getPost(post.id)).status, "posted");
    }),
  ),
);

it.effect("tells the source thread what went out in report-when-done mode only", () =>
  run(true, (world) =>
    Effect.gen(function* () {
      const { post } = yield* readyPost("report-when-done");
      yield* Ref.set(world.answers, { linkedin: { success: false, error: "Token expired" } });
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      yield* publisher.tick;
      const told = yield* Ref.get(world.told);
      assert.strictEqual(told.length, 1);
      assert.strictEqual(told[0]?.threadId, threadId);
      assert.include(told[0]?.text ?? "", post.id);
      assert.include(told[0]?.text ?? "", "Facebook: posted (https://x.test/facebook)");
      assert.include(told[0]?.text ?? "", "LinkedIn: failed (Token expired)");
    }),
  ),
);

it.effect("fails a post a restart interrupted and never sends it on its own", () =>
  run(false, (world) =>
    Effect.gen(function* () {
      const { store, post } = yield* readyPost("auto-publish");
      yield* store.beginPublishing(post.id);
      yield* Ref.set(world.publishing, true);
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      yield* Effect.scoped(publisher.start());
      const after = yield* store.getPost(post.id);
      assert.strictEqual(after.status, "failed");
      assert.strictEqual(
        after.publishResults.facebook?.error,
        CampaignStore.INTERRUPTED_BY_RESTART,
      );
      assert.strictEqual(yield* publisher.tick, 0);
      assert.deepStrictEqual(yield* Ref.get(world.sent), []);
    }),
  ),
);

it.effect("uploads files first through the engine and sends the post with its links", () =>
  run(
    true,
    (world) =>
      Effect.gen(function* () {
        const { store, post } = yield* readyPost("auto-publish", {
          platforms: ["instagram"],
          mediaPaths: ["clip.mp4"],
        });
        yield* Ref.set(world.upload, (current) =>
          store.recordUploadedMedia({
            postId: current.id,
            uploaded: { "clip.mp4": "https://cdn.test/clip.mp4" },
          }),
        );
        const publisher = yield* CampaignPublisher.CampaignPublisher;
        assert.strictEqual(yield* publisher.tick, 1);
        const sent = yield* Ref.get(world.seenPosts);
        assert.deepStrictEqual(sent[0]?.mediaUrls, ["https://cdn.test/clip.mp4"]);
        const done = yield* store.getPost(post.id);
        assert.strictEqual(done.status, "posted");
        assert.deepStrictEqual(done.uploadedMedia, { "clip.mp4": "https://cdn.test/clip.mp4" });
      }),
    "marketing-engine",
  ),
);

it.effect("fails the attempt with the reason when an upload fails, sending nothing", () =>
  run(
    true,
    (world) =>
      Effect.gen(function* () {
        const { store, post } = yield* readyPost("auto-publish", {
          mediaPaths: ["clip.mp4"],
        });
        yield* Ref.set(world.upload, () =>
          Effect.fail(
            new CampaignError({
              reason: "unavailable",
              message:
                "clip.mp4 was not uploaded: The storage service refused the keys (HTTP 403).",
            }),
          ),
        );
        const publisher = yield* CampaignPublisher.CampaignPublisher;
        assert.strictEqual(yield* publisher.tick, 1);
        assert.deepStrictEqual(yield* Ref.get(world.sent), []);
        const failed = yield* store.getPost(post.id);
        assert.strictEqual(failed.status, "failed");
        assert.include(failed.publishResults.facebook?.error ?? "", "refused the keys");
        assert.include(failed.publishResults.linkedin?.error ?? "", "refused the keys");
        assert.lengthOf(yield* store.publishLog(post.id), 2);
      }),
    "marketing-engine",
  ),
);

it.effect("does not ask for uploads when the connector is the export", () =>
  run(true, (world) =>
    Effect.gen(function* () {
      yield* readyPost("auto-publish", { mediaPaths: ["clip.mp4"] });
      yield* Ref.set(world.upload, () => Effect.die("storage must not be used by the export"));
      const publisher = yield* CampaignPublisher.CampaignPublisher;
      assert.strictEqual(yield* publisher.tick, 1);
    }),
  ),
);

it.effect("writes the report in words", () =>
  Effect.sync(() => {
    const text = CampaignPublisher.reportText(
      {
        id: "post-1",
        status: "posted",
        platforms: ["instagram"],
        publishResults: {
          instagram: { success: true, postId: "ig-1", at: "2026-10-06T12:00:00.000Z" },
        },
      } as never,
      { name: "Reels" },
    );
    assert.include(text, 'Your campaign post post-1 in "Reels" went out.');
    assert.include(text, "Instagram: posted (ig-1)");
  }),
);
