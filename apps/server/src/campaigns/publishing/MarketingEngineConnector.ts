import { captionFor } from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { enginePostType } from "./enginePostType.ts";
import type {
  AutopostState,
  ConnectorTestResult,
  PublishOutcome,
  PublishRequest,
  PublishingConnector,
} from "./PublishingConnector.ts";

/** Where and how to reach the engine. Null when either part is missing. */
export interface EngineConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Posting uploads media on the engine's side, so it gets longer than a status check. */
const PUBLISH_TIMEOUT = Duration.seconds(60);
const READ_TIMEOUT = Duration.seconds(10);

export const NO_PUBLIC_MEDIA =
  "This post's media has no public address yet. Turn on cloud storage or add a link.";
const NOT_CONFIGURED = "The marketing engine is not set up. Add its address and key first.";
const NO_CLIENT_ID =
  "This client has no publishing id yet, so the engine does not know who to post for.";

const failure = (error: string): PublishOutcome => ({ success: false, error });

interface EngineReply {
  readonly status: number;
  readonly body: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const errorFrom = (reply: EngineReply): string => {
  const message = asRecord(reply.body)["error"];
  return typeof message === "string" && message.trim() !== ""
    ? message
    : `The marketing engine answered with HTTP ${reply.status}.`;
};

/**
 * Posts through the Savage Digital Solutions marketing engine. The engine keeps its own kill
 * switches and this connector reads them before every post and never overrides them: a paused
 * client, a master switch that is off, or a state it cannot read all refuse the post.
 */
export function makeMarketingEngineConnector(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<EngineConfig | null>;
}): PublishingConnector {
  /**
   * One request, with one retry when the network itself failed. Anything that got an HTTP answer
   * is never sent again, and neither is a request that timed out: either may have posted.
   */
  const send = (
    config: EngineConfig,
    request: HttpClientRequest.HttpClientRequest,
    timeout: Duration.Duration,
  ): Effect.Effect<EngineReply, string> =>
    deps.http.execute(request.pipe(HttpClientRequest.setHeader("x-api-key", config.apiKey))).pipe(
      Effect.retry({ times: 1, while: (error) => error.reason._tag === "TransportError" }),
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.map((body): EngineReply => ({ status: response.status, body })),
        ),
      ),
      Effect.timeout(timeout),
      Effect.mapError((error) =>
        error._tag === "TimeoutError"
          ? "The marketing engine did not answer in time. Check the account before retrying."
          : error._tag === "HttpClientError" && error.reason._tag === "TransportError"
            ? "Could not reach the marketing engine."
            : "The request to the marketing engine failed.",
      ),
    );

  const endpoint = (config: EngineConfig, path: string) =>
    `${config.baseUrl.replace(/\/+$/, "")}${path}`;

  const post = (config: EngineConfig, path: string, body: unknown, timeout: Duration.Duration) =>
    HttpClientRequest.post(endpoint(config, path)).pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError(() => "The post could not be put into a request."),
      Effect.flatMap((request) => send(config, request, timeout)),
    );

  const autopostState: PublishingConnector["autopostState"] = (clientId) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { kind: "unavailable", reason: NOT_CONFIGURED } as const;
      const reply = yield* send(
        config,
        HttpClientRequest.get(endpoint(config, `/api/autopost/${encodeURIComponent(clientId)}`)),
        READ_TIMEOUT,
      );
      const body = asRecord(reply.body);
      if (
        reply.status !== 200 ||
        typeof body["autopostPaused"] !== "boolean" ||
        typeof body["masterEnabled"] !== "boolean"
      ) {
        return {
          kind: "unavailable",
          reason: "Could not read the engine's autopost switches.",
        } as const;
      }
      return {
        kind: "known",
        paused: body["autopostPaused"],
        masterEnabled: body["masterEnabled"],
      } as const;
    }).pipe(
      Effect.catch((reason: string): Effect.Effect<AutopostState> =>
        Effect.succeed({ kind: "unavailable", reason }),
      ),
    );

  /** Everything both calls need: where, who for, and media the engine can fetch. */
  const prepare = (request: PublishRequest) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { error: NOT_CONFIGURED } as const;
      const publishingClientId = request.client.publishingClientId;
      if (publishingClientId === undefined) return { error: NO_CLIENT_ID } as const;
      const { post: campaignPost, platform } = request;
      if (campaignPost.mediaUrls.length === 0 && campaignPost.mediaPaths.length > 0) {
        return { error: NO_PUBLIC_MEDIA } as const;
      }
      return {
        config,
        publishingClientId,
        body: {
          clientId: publishingClientId,
          platform,
          type: enginePostType(platform, campaignPost.mediaUrls),
          caption: captionFor(campaignPost, platform),
          mediaUrls: campaignPost.mediaUrls,
          hashtags: [] as string[],
        },
      } as const;
    });

  const publish: PublishingConnector["publish"] = (request) =>
    Effect.gen(function* () {
      const prepared = yield* prepare(request);
      if ("error" in prepared) return failure(prepared.error);
      const state = yield* autopostState(prepared.publishingClientId);
      if (state.kind === "unavailable") return failure(state.reason);
      if (!state.masterEnabled) {
        return failure(
          "The marketing engine's autopost master switch is off, so nothing was sent.",
        );
      }
      if (state.paused) {
        return failure(
          "Autopost is paused for this client in the marketing engine, so nothing was sent.",
        );
      }
      const reply = yield* post(
        prepared.config,
        "/api/social/publish",
        prepared.body,
        PUBLISH_TIMEOUT,
      );
      const body = asRecord(reply.body);
      if (reply.status < 200 || reply.status >= 300 || body["success"] !== true) {
        return failure(errorFrom(reply));
      }
      return {
        success: true,
        ...(typeof body["postId"] === "string" ? { postId: body["postId"] } : {}),
      };
    }).pipe(Effect.catch((error: string) => Effect.succeed(failure(error))));

  const schedule: PublishingConnector["schedule"] = (request) =>
    Effect.gen(function* () {
      const prepared = yield* prepare(request);
      if ("error" in prepared) return failure(prepared.error);
      const state = yield* autopostState(prepared.publishingClientId);
      if (state.kind === "unavailable") return failure(state.reason);
      if (!state.masterEnabled || state.paused) {
        return failure(
          "The marketing engine's autopost is switched off for this client, so nothing was scheduled.",
        );
      }
      const reply = yield* post(
        prepared.config,
        "/api/social/schedule",
        { ...prepared.body, scheduledAt: request.scheduledAt },
        PUBLISH_TIMEOUT,
      );
      return reply.status >= 200 &&
        reply.status < 300 &&
        asRecord(reply.body)["status"] === "scheduled"
        ? { success: true }
        : failure(errorFrom(reply));
    }).pipe(Effect.catch((error: string) => Effect.succeed(failure(error))));

  const test: PublishingConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as ConnectorTestResult;
      const reply = yield* send(
        config,
        HttpClientRequest.get(endpoint(config, "/health")),
        READ_TIMEOUT,
      );
      return reply.status >= 200 && reply.status < 300
        ? ({ ok: true } as ConnectorTestResult)
        : ({
            ok: false,
            reason: `The marketing engine answered with HTTP ${reply.status}.`,
          } as ConnectorTestResult);
    }).pipe(
      Effect.catch((reason: string) =>
        Effect.succeed({ ok: false, reason } as ConnectorTestResult),
      ),
    );

  return { kind: "marketing-engine", publish, schedule, autopostState, test };
}
