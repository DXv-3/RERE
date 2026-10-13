import { estimateGenerationUsd } from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { GenerationConnector, GenerationRequest } from "./GenerationConnector.ts";
import {
  asRecord,
  getJson,
  postJson,
  providerError,
  SHORT,
  type ProviderReply,
} from "./generationHttp.ts";

export interface OpenRouterConfig {
  readonly apiKey: string;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
export const DEFAULT_OPENROUTER_VIDEO_MODEL = "bytedance/seedance-2.0-fast";
/** Models the video request shape is known to work with. Others may be typed in settings. */
const KNOWN_OPENROUTER_VIDEO_MODELS = [
  "bytedance/seedance-2.0",
  "bytedance/seedance-2.0-fast",
  "bytedance/seedance-1-5-pro",
] as const;

const WHO = "OpenRouter";
const NOT_CONFIGURED =
  "OpenRouter has no key yet. Add one in Settings, Connections, Campaign Publishing.";
const IMAGE_TIMEOUT = Duration.minutes(3);
const NO_VIDEO = "OpenRouter did not return a video link.";

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

/** Only an OpenRouter address may be polled, because the poll carries the key. */
const isOpenRouterUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "openrouter.ai";
  } catch {
    return false;
  }
};

/**
 * OpenRouter with the user's own key. Video is asynchronous (submit, then poll the address it
 * returns); an image comes back in the chat completion as a data address.
 */
export function makeOpenRouterConnector(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<OpenRouterConfig | null>;
}): GenerationConnector {
  const headers = (config: OpenRouterConfig) => ({ Authorization: `Bearer ${config.apiKey}` });

  const startVideo = (config: OpenRouterConfig, request: GenerationRequest) =>
    Effect.gen(function* () {
      const { options } = request;
      const reply: ProviderReply = yield* postJson(
        deps.http,
        `${OPENROUTER_BASE}/videos`,
        headers(config),
        {
          model: request.model,
          prompt: request.prompt,
          aspect_ratio: options.aspectRatio,
          duration: options.durationSeconds,
          resolution: options.resolution,
          generate_audio: options.generateAudio ?? false,
          ...(request.firstFrameUrl === undefined
            ? {}
            : { frame_images: [{ url: request.firstFrameUrl, frame_type: "first" }] }),
        },
        SHORT,
        WHO,
      );
      const body = asRecord(reply.body);
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      const id = body["id"];
      const polling = body["polling_url"];
      if (typeof id !== "string" || id === "") {
        return yield* Effect.fail(
          "OpenRouter accepted the request but sent no job id. Check its usage page before trying again.",
        );
      }
      // confirm against OpenRouter's video generation docs: the fallback address when no polling_url is sent
      const pollAt =
        typeof polling === "string" && polling !== ""
          ? polling
          : `${OPENROUTER_BASE}/videos/${encodeURIComponent(id)}`;
      if (!isOpenRouterUrl(pollAt)) {
        return yield* Effect.fail(
          "OpenRouter sent a polling address that is not on openrouter.ai, so it was not used.",
        );
      }
      return { kind: "async", providerJobId: pollAt } as const;
    });

  const startImage = (config: OpenRouterConfig, request: GenerationRequest) =>
    Effect.gen(function* () {
      const reply = yield* postJson(
        deps.http,
        `${OPENROUTER_BASE}/chat/completions`,
        headers(config),
        {
          model: request.model,
          messages: [{ role: "user", content: request.prompt }],
          modalities: ["image", "text"],
          ...(request.options.aspectRatio === undefined
            ? {}
            : { image_config: { aspect_ratio: request.options.aspectRatio } }),
        },
        IMAGE_TIMEOUT,
        WHO,
      );
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      // confirm against OpenRouter's image generation docs
      const choices = asRecord(reply.body)["choices"];
      const message = asRecord(Array.isArray(choices) ? choices[0] : undefined)["message"];
      const images = asRecord(message)["images"];
      const urls = Array.isArray(images)
        ? images.flatMap((image) => strings([asRecord(asRecord(image)["image_url"])["url"]]))
        : [];
      if (urls.length === 0) {
        return yield* Effect.fail(
          "OpenRouter answered but the model returned no image. Try a different image model in Settings.",
        );
      }
      return { kind: "finished", urls } as const;
    });

  const start: GenerationConnector["start"] = (request) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      return yield* request.kind === "video"
        ? startVideo(config, request)
        : startImage(config, request);
    });

  const poll: GenerationConnector["poll"] = (providerJobId) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      if (!isOpenRouterUrl(providerJobId)) {
        return {
          state: "failed",
          reason: "The stored job address is not an OpenRouter address.",
        } as const;
      }
      const reply = yield* getJson(deps.http, providerJobId, headers(config), SHORT, WHO);
      if (
        reply.status >= 400 &&
        reply.status < 500 &&
        reply.status !== 408 &&
        reply.status !== 429
      ) {
        return { state: "failed", reason: providerError(reply, WHO) } as const;
      }
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      const body = asRecord(reply.body);
      const status = body["status"];
      if (typeof status !== "string")
        return yield* Effect.fail("OpenRouter sent a status this app cannot read.");
      if (status === "completed") {
        const urls = strings(body["unsigned_urls"]);
        return urls.length === 0
          ? ({ state: "failed", reason: NO_VIDEO } as const)
          : ({ state: "done", urls: [urls[0] as string] } as const);
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        const error = body["error"];
        return {
          state: "failed",
          reason:
            typeof error === "string" && error.trim() !== ""
              ? `OpenRouter said: ${error.slice(0, 300)}`
              : `OpenRouter reported the job as ${status}.`,
        } as const;
      }
      return { state: "running" } as const;
    });

  const test: GenerationConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as const;
      const reply = yield* getJson(
        deps.http,
        `${OPENROUTER_BASE}/key`,
        headers(config),
        SHORT,
        WHO,
      );
      return reply.status >= 200 && reply.status < 300
        ? ({ ok: true } as const)
        : ({ ok: false, reason: providerError(reply, WHO) } as const);
    }).pipe(Effect.catch((reason: string) => Effect.succeed({ ok: false, reason } as const)));

  return {
    kind: "openrouter",
    estimate: (request) =>
      estimateGenerationUsd({
        connector: "openrouter",
        kind: request.kind,
        model: request.model,
        durationSeconds: request.options.durationSeconds,
      }),
    start,
    poll,
    test,
  };
}
