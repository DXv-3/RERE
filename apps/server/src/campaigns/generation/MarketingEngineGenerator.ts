import { estimateGenerationUsd } from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { EngineConfig } from "../publishing/MarketingEngineConnector.ts";
import type { GenerationConnector } from "./GenerationConnector.ts";
import { asRecord, getJson, postJson, providerError, SHORT } from "./generationHttp.ts";

const WHO = "the marketing engine";
const NOT_CONFIGURED = "The marketing engine is not set up. Add its address and key first.";
const NO_CLIENT_ID =
  "This client has no publishing id yet, so the engine does not know who to make the video for.";
const NO_LINK = "The engine did not return a video link.";
/** The engine answers when the video is finished, which can take minutes. */
const VIDEO_TIMEOUT = Duration.minutes(10);

const httpsString = (value: unknown): string | null =>
  typeof value === "string" && value.startsWith("https://") ? value : null;

/** Looks for the video address where the engine is likely to put it. */
export const engineVideoUrl = (body: unknown): string | null => {
  const root = asRecord(body);
  return (
    httpsString(root["videoUrl"]) ??
    httpsString(asRecord(root["result"])["videoUrl"]) ??
    httpsString(asRecord(root["video"])["url"])
  );
};

/** Video through the Savage Digital Solutions marketing engine, reusing its address and key. */
export function makeMarketingEngineGenerator(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<EngineConfig | null>;
}): GenerationConnector {
  const start: GenerationConnector["start"] = (request) =>
    Effect.gen(function* () {
      if (request.kind === "image") {
        return yield* Effect.fail(
          "The marketing engine is used for video. Choose OpenRouter or a local server for images.",
        );
      }
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      if (request.engineClientId === undefined) return yield* Effect.fail(NO_CLIENT_ID);
      // confirm against apps/marketing-engine createVideoCampaign: the accepted values of videoType,
      // pillar, pipeline, quality, provider and industry are guesses at its defaults.
      const reply = yield* postJson(
        deps.http,
        `${config.baseUrl.replace(/\/+$/, "")}/api/campaigns/video`,
        { "x-api-key": config.apiKey },
        {
          clientId: request.engineClientId,
          name: request.name,
          videoType: "reel",
          topic: request.prompt,
          pillar: "brand",
          platforms: ["instagram"],
          pipeline: "auto",
          quality: "standard",
          provider: "auto",
          industry: "general",
          useImageToVideo: request.firstFrameUrl !== undefined,
        },
        VIDEO_TIMEOUT,
        WHO,
      );
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      // confirm against apps/marketing-engine createVideoCampaign: where the finished video's address is
      const url = engineVideoUrl(reply.body);
      return url === null
        ? yield* Effect.fail(NO_LINK)
        : ({ kind: "finished", urls: [url] } as const);
    });

  const test: GenerationConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as const;
      const reply = yield* getJson(
        deps.http,
        `${config.baseUrl.replace(/\/+$/, "")}/health`,
        { "x-api-key": config.apiKey },
        SHORT,
        WHO,
      );
      return reply.status >= 200 && reply.status < 300
        ? ({ ok: true } as const)
        : ({
            ok: false,
            reason: `The marketing engine answered with HTTP ${reply.status}.`,
          } as const);
    }).pipe(Effect.catch((reason: string) => Effect.succeed({ ok: false, reason } as const)));

  return {
    kind: "marketing-engine",
    estimate: (request) =>
      estimateGenerationUsd({
        connector: "marketing-engine",
        kind: request.kind,
        model: request.model,
        durationSeconds: request.options.durationSeconds,
      }),
    start,
    poll: () => Effect.succeed({ state: "failed", reason: "The engine has no jobs to poll." }),
    test,
  };
}
