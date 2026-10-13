import {
  CAMPAIGN_MODEL_CAPABILITIES,
  campaignImageDimensions,
  campaignModelOptionsError,
  getCampaignModelCapability,
} from "@t3tools/shared/campaignModelCapabilities";
import { estimateGenerationUsd } from "@t3tools/shared/campaignRules";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { GenerationConnector, GenerationRequest } from "./GenerationConnector.ts";
import {
  asRecord,
  getJson,
  postJson,
  providerError,
  type ProviderReply,
  SHORT,
} from "./generationHttp.ts";

export interface FalConfig {
  readonly apiKey: string;
}

const FAL_QUEUE_HOST = "queue.fal.run";
export const DEFAULT_FAL_VIDEO_MODEL = "fal-ai/veo3.1/image-to-video";
export const DEFAULT_FAL_TEXT_VIDEO_MODEL = "fal-ai/veo3.1";
export const DEFAULT_FAL_IMAGE_MODEL = "fal-ai/flux/dev";
/** Video models whose request controls are verified by the shared capability registry. */
export const KNOWN_FAL_VIDEO_MODELS = CAMPAIGN_MODEL_CAPABILITIES.filter(
  (entry) => entry.connector === "fal" && entry.kind === "video",
).map((entry) => entry.model);

const WHO = "fal.ai";
const NOT_CONFIGURED =
  "fal.ai has no key yet. Add one in Settings, Connections, Campaign Publishing.";
const ENDPOINT_ID = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;

/** The queue address of a model, each segment encoded and the slashes kept. */
const endpointAddress = (endpointId: string): string =>
  `https://${FAL_QUEUE_HOST}/${endpointId.split("/").map(encodeURIComponent).join("/")}`;

/** A stored response address is only trusted if it is plain https on fal's queue host. */
const queueAddress = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== FAL_QUEUE_HOST ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** fal's own words for a failed job: `detail` is a string, or a list whose first item has `msg`. */
const failureSentence = (reply: ProviderReply): string => {
  const detail = asRecord(reply.body)["detail"];
  const first = Array.isArray(detail) ? asRecord(detail[0])["msg"] : detail;
  const text = typeof first === "string" ? first.trim().slice(0, 300) : "";
  return text === "" ? `${WHO} answered with HTTP ${reply.status}.` : `${WHO} said: ${text}`;
};

/**
 * fal.ai with the user's own key. Every model is a queue endpoint: submit to its address, then
 * poll the response address the submit reply names. That address is checked before each poll, so
 * the key only ever goes to queue.fal.run.
 */
export function makeFalConnector(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<FalConfig | null>;
}): GenerationConnector {
  const headers = (config: FalConfig) => ({ Authorization: `Key ${config.apiKey}` });

  const start: GenerationConnector["start"] = (request: GenerationRequest) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      // "." and ".." pass the pattern but would walk out of the model's address
      if (
        !ENDPOINT_ID.test(request.model) ||
        request.model.split("/").some((part) => /^\.+$/.test(part))
      ) {
        return yield* Effect.fail(
          "The fal.ai model name has characters it cannot have. Check it in Settings.",
        );
      }
      const { options } = request;
      const capability = getCampaignModelCapability("fal", request.model);
      if (capability === undefined)
        return yield* Effect.fail("Choose a supported model from the model list.");
      const optionError = campaignModelOptionsError(capability, request.kind, {
        ...options,
        ...(request.firstFrameUrl === undefined ? {} : { firstFrame: request.firstFrameUrl }),
      });
      if (optionError !== null) return yield* Effect.fail(optionError);
      const video = request.kind === "video";
      const frame = request.firstFrameUrl;
      const hasFrame = frame !== undefined && frame !== "";
      // Kling V3's I2V schema uses start_image_url and derives size/crop from the image.
      // https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api
      const klingV3 = /^fal-ai\/kling-video\/v3\/(pro|standard)\/image-to-video$/.test(
        request.model,
      );
      if (video) {
        if (hasFrame && request.model.includes("text-to-video")) {
          return yield* Effect.fail(
            `${request.model} makes video from text only, but this video starts from a still image. Pick an image-to-video model in Settings.`,
          );
        }
        if (!hasFrame && request.model.includes("image-to-video")) {
          return yield* Effect.fail(
            `${request.model} needs a starting image. Add a first frame, or pick a text-to-video model in Settings.`,
          );
        }
      }
      // confirm against the model's schema on fal: Veo takes "8s", Kling and Seedance take "5"
      const duration =
        options.durationSeconds === undefined
          ? undefined
          : request.model.includes("veo")
            ? `${options.durationSeconds}s`
            : `${options.durationSeconds}`;
      const reply = yield* postJson(
        deps.http,
        endpointAddress(request.model),
        headers(config),
        {
          prompt: request.prompt,
          // confirm against fal's docs: data addresses accepted for image_url
          ...(video && hasFrame
            ? klingV3
              ? { start_image_url: frame }
              : { image_url: frame }
            : {}),
          ...(!video
            ? { image_size: campaignImageDimensions(options.aspectRatio), num_images: 1 }
            : options.aspectRatio === undefined || klingV3
              ? {}
              : { aspect_ratio: options.aspectRatio }),
          ...(video && duration !== undefined ? { duration } : {}),
          ...(video && options.resolution !== undefined && !klingV3
            ? { resolution: options.resolution }
            : {}),
          ...(video && options.generateAudio !== undefined
            ? { generate_audio: options.generateAudio }
            : {}),
        },
        SHORT,
        WHO,
      ).pipe(Effect.orElseSucceed(() => ({ status: 0, body: undefined })));
      if (reply.status === 0 || reply.status === 408 || reply.status >= 500) {
        return {
          kind: "uncertain",
          reason:
            "The provider may have accepted this request. Reconcile it in the provider dashboard; this job will not be resubmitted.",
        } as const;
      }
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      const responseUrl = asRecord(reply.body)["response_url"];
      const address = typeof responseUrl === "string" ? queueAddress(responseUrl) : null;
      if (address === null) {
        return {
          kind: "uncertain",
          reason:
            "fal.ai accepted the request but sent no usable result address. Reconcile it in its dashboard; this job will not be resubmitted.",
        } as const;
      }
      return { kind: "async", providerJobId: address } as const;
    });

  const poll: GenerationConnector["poll"] = (providerJobId) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      const address = queueAddress(providerJobId);
      if (address === null) {
        return {
          state: "failed",
          reason: "The stored job address is not a fal.ai queue address.",
        } as const;
      }
      const status = yield* getJson(deps.http, `${address}/status`, headers(config), SHORT, WHO);
      if (
        status.status >= 400 &&
        status.status < 500 &&
        status.status !== 408 &&
        status.status !== 429
      ) {
        return { state: "failed", reason: providerError(status, WHO) } as const;
      }
      if (status.status < 200 || status.status >= 300)
        return yield* Effect.fail(providerError(status, WHO));
      const state = asRecord(status.body)["status"];
      if (state === "IN_QUEUE" || state === "IN_PROGRESS") return { state: "running" } as const;
      if (state !== "COMPLETED") {
        return yield* Effect.fail("fal.ai sent a status this app cannot read.");
      }
      const result = yield* getJson(deps.http, address, headers(config), SHORT, WHO);
      if (result.status < 200 || result.status >= 300) {
        // A failed job answers COMPLETED on status, then an error from the response address.
        return { state: "failed", reason: failureSentence(result) } as const;
      }
      const body = asRecord(result.body);
      const videoUrl = asRecord(body["video"])["url"];
      const images = body["images"];
      const imageUrl = Array.isArray(images) ? asRecord(images[0])["url"] : undefined;
      const url = isHttpsUrl(videoUrl) ? videoUrl : isHttpsUrl(imageUrl) ? imageUrl : undefined;
      return url === undefined
        ? ({ state: "failed", reason: "fal.ai did not return a link to the result." } as const)
        : ({ state: "done", urls: [url] } as const);
    });

  const test: GenerationConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as const;
      return {
        ok: true,
        notes:
          "The key is saved. fal.ai has no way to check a key without running a model, so the first video is the real test.",
      } as const;
    });

  return {
    kind: "fal",
    estimate: (request) =>
      estimateGenerationUsd({
        connector: "fal",
        kind: request.kind,
        model: request.model,
        durationSeconds: request.options.durationSeconds,
      }),
    start,
    poll,
    test,
  };
}
