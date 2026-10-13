import { assert, it } from "@effect/vitest";
import { ThreadId, type CampaignPostContentInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CampaignStore from "./CampaignStore.ts";
import * as CampaignThreadNotifier from "./CampaignThreadNotifier.ts";

const threadId = ThreadId.make("thread-agent");
const agent = { kind: "agent", threadId } as const;
const person = { kind: "person" } as const;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

interface Told {
  readonly threadId: string;
  readonly key: string;
  readonly text: string;
}

const makeLayer = (told: Ref.Ref<ReadonlyArray<Told>>) =>
  CampaignStore.layer.pipe(
    Layer.provide(
      Layer.succeed(
        CampaignThreadNotifier.CampaignThreadNotifier,
        CampaignThreadNotifier.CampaignThreadNotifier.of({
          tell: (input) => Ref.update(told, (all) => [...all, input]),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const content = (overrides: Partial<CampaignPostContentInput> = {}): CampaignPostContentInput => ({
  platforms: ["facebook"],
  captions: { default: "Fresh work from the studio", byPlatform: {} },
  mediaPaths: [],
  mediaUrls: [],
  ...overrides,
});

/** A client and campaign in the given modes, and the store to work on them. */
const setup = (
  clientMode: "ask-first" | "report-when-done" | "auto-publish" = "ask-first",
  campaignMode?: "ask-first" | "report-when-done" | "auto-publish",
  doNotSay: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const store = yield* CampaignStore.CampaignStore;
    const client = yield* store.upsertClient({
      name: "Candid Studios",
      brandNotes: "Warm and plain",
      doNotSay,
      approvalMode: clientMode,
    });
    const campaign = yield* store.upsertCampaign({
      clientId: client.id,
      name: "October reels",
      ...(campaignMode === undefined ? {} : { approvalMode: campaignMode }),
    });
    return { store, client, campaign };
  });

const layerFor = <A, E>(
  run: (told: Ref.Ref<ReadonlyArray<Told>>) => Effect.Effect<A, E, CampaignStore.CampaignStore>,
) =>
  Effect.gen(function* () {
    const told = yield* Ref.make<ReadonlyArray<Told>>([]);
    return yield* run(told).pipe(Effect.provide(makeLayer(told)));
  });

const failureOf = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect);

it.effect("keeps clients and campaigns, defaults to ask-first, and counts posts by status", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, client, campaign } = yield* setup();
      assert.strictEqual(client.approvalMode, "ask-first");
      assert.strictEqual(campaign.approvalMode, undefined);
      yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      const second = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      yield* store.submitPost(agent, second.id);
      const listed = yield* store.listCampaigns(client.id);
      assert.deepStrictEqual(listed[0]?.postCounts, { draft: 1, "needs-approval": 1 });

      const renamed = yield* store.upsertClient({
        id: client.id,
        name: "Candid",
        brandNotes: "",
        doNotSay: [" cheap ", "", "cheap"],
      });
      assert.strictEqual(renamed.approvalMode, "ask-first");
      assert.deepStrictEqual(renamed.doNotSay, ["cheap"]);
      assert.strictEqual((yield* failureOf(store.getClient("nope"))).reason, "not_found");
    }),
  ),
);

it.effect("never lets an agent's submit approve a post under ask-first", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("ask-first");
      const draft = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      assert.strictEqual(draft.status, "draft");
      assert.deepStrictEqual(draft.createdBy, agent);
      assert.strictEqual(draft.sourceThreadId, threadId);

      const submitted = yield* store.submitPost(agent, draft.id);
      assert.strictEqual(submitted.status, "needs-approval");
      assert.strictEqual(submitted.approval, null);

      // Once it is waiting, an agent can take it back to edit, never approve or send it.
      const edited = yield* store.savePost(agent, {
        ...content({ captions: { default: "Better words", byPlatform: {} } }),
        id: draft.id,
        campaignId: campaign.id,
      });
      assert.strictEqual(edited.status, "draft");
      yield* store.submitPost(agent, draft.id);
      const approved = yield* store.approvePost({ postId: draft.id });
      assert.strictEqual(approved.status, "approved");
      assert.strictEqual(approved.approval?.by, "person");

      const refused = yield* failureOf(
        store.savePost(agent, { ...content(), id: draft.id, campaignId: campaign.id }),
      );
      assert.strictEqual(refused.reason, "not_allowed");
      assert.strictEqual(
        (yield* failureOf(store.submitPost(agent, draft.id))).reason,
        "not_allowed",
      );
      assert.strictEqual((yield* store.getPost(draft.id)).status, "approved");
    }),
  ),
);

it.effect("a person's submit waits for approval whatever the mode", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("auto-publish");
      const draft = yield* store.savePost(
        { kind: "person" },
        { ...content(), campaignId: campaign.id },
      );
      const submitted = yield* store.submitPost({ kind: "person" }, draft.id);
      assert.strictEqual(submitted.status, "needs-approval");
      assert.isNull(submitted.approval);
    }),
  ),
);

it.effect("approves by the mode a person set, and schedules a future time", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("report-when-done");
      const now = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      const sent = yield* store.submitPost(agent, now.id);
      assert.strictEqual(sent.status, "approved");
      assert.deepStrictEqual(sent.approval, {
        by: "mode",
        mode: "report-when-done",
        at: "2026-10-06T12:00:00.000Z",
      });

      const later = yield* store.savePost(agent, {
        ...content({ scheduledAt: "2026-10-07T09:00:00.000Z" }),
        campaignId: campaign.id,
      });
      const scheduled = yield* store.submitPost(agent, later.id);
      assert.strictEqual(scheduled.status, "scheduled");
      assert.strictEqual(scheduled.scheduledAt, "2026-10-07T09:00:00.000Z");
    }),
  ),
);

it.effect("lets a campaign's mode override its client's", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("auto-publish", "ask-first");
      const draft = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      assert.strictEqual((yield* store.submitPost(agent, draft.id)).status, "needs-approval");
    }),
  ),
);

it.effect("refuses to submit a post that is not ready, naming what is missing", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("ask-first", undefined, ["best price"]);
      const pin = yield* store.savePost(agent, {
        ...content({ platforms: ["pinterest"], mediaUrls: ["https://cdn.test/a.png"] }),
        campaignId: campaign.id,
      });
      const missing = yield* failureOf(store.submitPost(agent, pin.id));
      assert.strictEqual(missing.reason, "invalid");
      assert.include(missing.message, "Pinterest needs a title.");
      assert.include(missing.message, "Pinterest needs a destination link.");

      const risky = yield* store.savePost(agent, {
        ...content({ captions: { default: "Our Best Price yet", byPlatform: {} } }),
        campaignId: campaign.id,
      });
      const blocked = yield* failureOf(store.submitPost(agent, risky.id));
      assert.include(blocked.message, "do-not-say");
      assert.strictEqual(
        (yield* failureOf(store.approvePost({ postId: risky.id }))).reason,
        "invalid",
      );
    }),
  ),
);

it.effect("rejects paths that climb out of the folder and links that are not web addresses", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup();
      for (const bad of [
        content({ mediaPaths: ["../secrets.png"] }),
        content({ mediaPaths: ["/etc/passwd"] }),
        content({ mediaUrls: ["file:///etc/passwd"] }),
        content({ scheduledAt: "tomorrow-ish" }),
      ]) {
        const refused = yield* failureOf(
          store.savePost(agent, { ...bad, campaignId: campaign.id }),
        );
        assert.strictEqual(refused.reason, "invalid");
      }
    }),
  ),
);

it.effect("sends changes back to the agent's thread and drops the approval", () =>
  layerFor((told) =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup();
      const draft = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      yield* store.submitPost(agent, draft.id);
      const back = yield* store.requestChanges({ postId: draft.id, text: "Tighten the cut" });
      assert.strictEqual(back.status, "draft");
      assert.strictEqual(back.changeRequest, "Tighten the cut");
      const messages = yield* Ref.get(told);
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]?.threadId, threadId);
      assert.include(messages[0]?.text ?? "", "Tighten the cut");

      // Submitting again answers the request.
      const again = yield* store.submitPost(agent, draft.id);
      assert.strictEqual(again.changeRequest, undefined);

      const rejected = yield* store.rejectPost(draft.id);
      assert.strictEqual(rejected.status, "rejected");
      assert.strictEqual(
        (yield* failureOf(store.requestChanges({ postId: draft.id, text: "x" }))).reason,
        "not_allowed",
      );
    }),
  ),
);

it.effect("publishes platform by platform, logs each attempt, and retries only what failed", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("auto-publish");
      const draft = yield* store.savePost(agent, {
        ...content({ platforms: ["facebook", "linkedin"] }),
        campaignId: campaign.id,
      });
      yield* store.submitPost(agent, draft.id);
      assert.deepStrictEqual(
        (yield* store.listDue("2026-10-06T12:00:00.000Z")).map((post) => post.id),
        [draft.id],
      );

      assert.isTrue(yield* store.beginPublishing(draft.id));
      assert.isFalse(yield* store.beginPublishing(draft.id));
      assert.deepStrictEqual(yield* store.listDue("2026-10-06T12:00:00.000Z"), []);

      yield* store.recordPublishResult({
        postId: draft.id,
        platform: "facebook",
        result: { success: true, postId: "fb-1" },
      });
      yield* store.recordPublishResult({
        postId: draft.id,
        platform: "linkedin",
        result: { success: false, error: "Token expired" },
      });
      const failed = yield* store.finishPublishing(draft.id);
      assert.strictEqual(failed.status, "failed");
      assert.strictEqual(failed.publishResults.facebook?.success, true);
      assert.strictEqual(failed.publishResults.linkedin?.error, "Token expired");

      const log = yield* store.publishLog(draft.id);
      assert.deepStrictEqual(
        log.map((entry) => [entry.platform, entry.result, entry.mode, entry.approvedBy]),
        [
          ["facebook", "success", "auto-publish", "mode:auto-publish"],
          ["linkedin", "failure", "auto-publish", "mode:auto-publish"],
        ],
      );

      // Only a person retries, and the platform that already went out keeps its result.
      const retried = yield* store.retryPost(draft.id);
      assert.strictEqual(retried.status, "approved");
      assert.strictEqual(retried.approval?.by, "person");
      assert.strictEqual(retried.publishResults.facebook?.success, true);
      yield* store.beginPublishing(draft.id);
      yield* store.recordPublishResult({
        postId: draft.id,
        platform: "linkedin",
        result: { success: true, postId: "li-1" },
      });
      const posted = yield* store.finishPublishing(draft.id);
      assert.strictEqual(posted.status, "posted");
      assert.strictEqual((yield* store.publishLog(draft.id)).at(-1)?.approvedBy, "person");
      assert.strictEqual((yield* failureOf(store.retryPost(draft.id))).reason, "not_allowed");
      assert.strictEqual((yield* failureOf(store.deletePost("nope"))).reason, "not_found");
    }),
  ),
);

it.effect("holds an approved post for its time and releases it when the time comes", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup();
      const draft = yield* store.savePost(person, {
        ...content({ scheduledAt: "2026-10-06T15:00:00.000Z" }),
        campaignId: campaign.id,
      });
      const scheduled = yield* store.approvePost({ postId: draft.id });
      assert.strictEqual(scheduled.status, "scheduled");
      assert.deepStrictEqual(yield* store.listDue("2026-10-06T14:59:00.000Z"), []);
      assert.strictEqual((yield* store.listDue("2026-10-06T15:00:00.000Z")).length, 1);

      const now = yield* store.publishNow(draft.id);
      assert.strictEqual(now.status, "approved");
      assert.strictEqual(now.scheduledAt, undefined);
      assert.strictEqual((yield* store.listDue("2026-10-06T12:00:00.000Z")).length, 1);

      // Editing what was approved drops it back to a draft that needs approving again.
      const edited = yield* store.savePost(person, {
        ...content(),
        id: draft.id,
        campaignId: campaign.id,
      });
      assert.strictEqual(edited.status, "draft");
      assert.strictEqual(edited.approval, null);
    }),
  ),
);

it.effect("fails a post found mid-publish after a restart and never sends it again", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, campaign } = yield* setup("auto-publish");
      const draft = yield* store.savePost(agent, {
        ...content({ platforms: ["facebook", "linkedin"] }),
        campaignId: campaign.id,
      });
      yield* store.submitPost(agent, draft.id);
      yield* store.beginPublishing(draft.id);
      yield* store.recordPublishResult({
        postId: draft.id,
        platform: "facebook",
        result: { success: true },
      });

      const recovered = yield* store.recoverInterrupted;
      assert.strictEqual(recovered.length, 1);
      const post = yield* store.getPost(draft.id);
      assert.strictEqual(post.status, "failed");
      assert.strictEqual(post.publishResults.facebook?.success, true);
      assert.strictEqual(
        post.publishResults.linkedin?.error,
        "Interrupted by a restart. Check the account before retrying.",
      );
      assert.deepStrictEqual(yield* store.listDue("2026-10-07T00:00:00.000Z"), []);
      assert.strictEqual((yield* store.recoverInterrupted).length, 0);
    }),
  ),
);

it.effect("deletes a client with its campaigns and posts, keeping the publish log", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const { store, client, campaign } = yield* setup("auto-publish");
      const draft = yield* store.savePost(agent, { ...content(), campaignId: campaign.id });
      yield* store.submitPost(agent, draft.id);
      yield* store.beginPublishing(draft.id);
      assert.strictEqual((yield* failureOf(store.deleteClient(client.id))).reason, "conflict");
      yield* store.recordPublishResult({
        postId: draft.id,
        platform: "facebook",
        result: { success: true },
      });
      yield* store.finishPublishing(draft.id);

      yield* store.deleteClient(client.id);
      assert.deepStrictEqual(yield* store.listClients, []);
      assert.deepStrictEqual(yield* store.listCampaigns(), []);
      assert.strictEqual((yield* failureOf(store.getPost(draft.id))).reason, "not_found");
      assert.strictEqual((yield* store.publishLog(draft.id)).length, 1);
    }),
  ),
);

it.effect("tells subscribers about every change", () =>
  layerFor(() =>
    Effect.gen(function* () {
      const store = yield* CampaignStore.CampaignStore;
      const watcher = yield* store.subscribeChanges.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* store.upsertClient({ name: "A", brandNotes: "", doNotSay: [] });
      yield* store.upsertClient({ name: "B", brandNotes: "", doNotSay: [] });
      const seen = yield* Fiber.join(watcher);
      assert.deepStrictEqual([...seen], [0, 1, 2]);
    }),
  ),
);
