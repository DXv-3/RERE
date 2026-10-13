import {
  CAMPAIGN_PLATFORM_LABELS,
  type Campaign,
  type CampaignPost,
  type CampaignPlatform,
  type ThreadId,
} from "@t3tools/contracts";
import { effectiveMode } from "@t3tools/shared/campaignRules";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as CampaignConnection from "./CampaignConnection.ts";
import * as CampaignStore from "./CampaignStore.ts";
import * as CampaignThreadNotifier from "./CampaignThreadNotifier.ts";
import * as CampaignStorage from "./storage/CampaignStorage.ts";
import type { PublishOutcome } from "./publishing/PublishingConnector.ts";

const TICK_INTERVAL = "1 minute";

/** What the agent that made a post is told when it went out in "report when done" mode. */
export function reportText(post: CampaignPost, campaign: Pick<Campaign, "name">): string {
  const lines = post.platforms.map((platform) => {
    const result = post.publishResults[platform];
    const label = CAMPAIGN_PLATFORM_LABELS[platform];
    if (result === undefined) return `- ${label}: not attempted`;
    if (!result.success) return `- ${label}: failed (${result.error ?? "no reason given"})`;
    const where = result.link ?? result.postId;
    return where === undefined ? `- ${label}: posted` : `- ${label}: posted (${where})`;
  });
  const headline =
    post.status === "posted"
      ? `Your campaign post ${post.id} in "${campaign.name}" went out.`
      : `Your campaign post ${post.id} in "${campaign.name}" did not go out everywhere.`;
  return `${headline}\n\n${lines.join("\n")}`;
}

/**
 * Posts what a person approved, at its time. Nothing here approves anything: it takes the posts
 * the store says are due, asks the active connector to send each platform, and records what came
 * back. With the server setting `campaignPublishing` off it sends nothing to any connector.
 */
export class CampaignPublisher extends Context.Service<
  CampaignPublisher,
  {
    /** One pass over the posts that are due. Returns how many it picked up. */
    readonly tick: Effect.Effect<number>;
    /**
     * Fails whatever a restart interrupted, then runs `tick` about once a minute. An interrupted
     * post is never sent again on its own: it may already have gone out.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/campaigns/CampaignPublisher") {}

const make = Effect.gen(function* () {
  const store = yield* CampaignStore.CampaignStore;
  const connection = yield* CampaignConnection.CampaignConnection;
  const notifier = yield* CampaignThreadNotifier.CampaignThreadNotifier;
  const storage = yield* CampaignStorage.CampaignStorage;
  // The timer and a person's "publish now" can both ask for a pass; one at a time.
  const passes = yield* Semaphore.make(1);

  const quietly = <A, E>(label: string, effect: Effect.Effect<A, E>, fallback: A) =>
    effect.pipe(
      Effect.orDie,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(label, { cause: Cause.pretty(cause) }).pipe(Effect.as(fallback)),
      ),
    );

  const publishOne = (post: CampaignPost) =>
    Effect.gen(function* () {
      const { client, campaign } = yield* store.contextOf(post);
      if (!(yield* store.beginPublishing(post.id))) return false;
      const connector = yield* connection.active;
      // A platform that already went out on an earlier attempt is not sent again.
      const todo = post.platforms.filter(
        (platform: CampaignPlatform) => post.publishResults[platform]?.success !== true,
      );
      // Files with no public address go to cloud storage first, when the owner has it on. A failed
      // upload fails every platform of this attempt with its reason, and nothing is sent anywhere.
      const prepared = yield* connector.kind === "marketing-engine"
        ? storage.ensurePublicMedia(post).pipe(
            Effect.map((withLinks) => ({ post: withLinks }) as const),
            Effect.catchTag("CampaignError", (error) =>
              Effect.succeed({ failed: error.message } as const),
            ),
          )
        : Effect.succeed({ post } as const);
      for (const platform of todo) {
        if ("failed" in prepared) {
          yield* store.recordPublishResult({
            postId: post.id,
            platform,
            result: { success: false, error: prepared.failed },
          });
          continue;
        }
        const outcome: PublishOutcome = yield* connector
          .publish({ post: prepared.post, platform, client, campaign })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.succeed({
                    success: false,
                    error:
                      "The publisher hit an unexpected error. Check the account before retrying.",
                  } satisfies PublishOutcome),
            ),
          );
        yield* store.recordPublishResult({
          postId: post.id,
          platform,
          result: {
            success: outcome.success,
            ...(outcome.postId === undefined ? {} : { postId: outcome.postId }),
            ...(outcome.link === undefined ? {} : { link: outcome.link }),
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          },
        });
      }
      const finished = yield* store.finishPublishing(post.id);
      if (
        effectiveMode(client, campaign) === "report-when-done" &&
        finished.sourceThreadId !== undefined
      ) {
        yield* notifier.tell({
          threadId: finished.sourceThreadId as ThreadId,
          key: `published:${finished.id}:${finished.updatedAt}`,
          text: reportText(finished, campaign),
        });
      }
      return true;
    });

  const tick: CampaignPublisher["Service"]["tick"] = passes.withPermit(
    Effect.gen(function* () {
      if (!(yield* connection.publishingOn)) return 0;
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      const due = yield* store.listDue(at);
      let picked = 0;
      for (const post of due) {
        const claimed = yield* quietly(
          "a campaign post could not be published",
          publishOne(post),
          false,
        );
        if (claimed) picked += 1;
      }
      return picked;
    }).pipe((effect) => quietly("the campaign publisher pass failed", effect, 0)),
  );

  const start: CampaignPublisher["Service"]["start"] = Effect.fn("CampaignPublisher.start")(
    function* () {
      const recovered = yield* quietly(
        "could not recover campaign posts interrupted by a restart",
        store.recoverInterrupted,
        [],
      );
      if (recovered.length > 0) {
        yield* Effect.logWarning(
          "campaign posts were interrupted by a restart and were not resent",
          {
            count: recovered.length,
          },
        );
      }
      yield* forkParked(tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)), Effect.asVoid));
    },
  );

  return CampaignPublisher.of({ tick, start });
});

export const layer = Layer.effect(CampaignPublisher, make);
