import {
  CAMPAIGN_MODEL_CAPABILITIES,
  campaignImageDimensions,
  campaignModelOptionsError,
  getCampaignModelCapability,
} from "@t3tools/shared/campaignModelCapabilities";
import { estimateGenerationUsd } from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { GenerationConnector, GenerationRequest } from "./GenerationConnector.ts";
import {
  asRecord,
  callProvider,
  getJson,
  postJson,
  providerError,
  SHORT,
} from "./generationHttp.ts";

export interface MuapiConfig {
  readonly apiKey: string;
}

const MUAPI_BASE = "https://api.muapi.ai/api/v1";
export const DEFAULT_MUAPI_VIDEO_MODEL = "veo3.1-image-to-video";
export const DEFAULT_MUAPI_TEXT_VIDEO_MODEL = "veo3.1-text-to-video";
export const DEFAULT_MUAPI_IMAGE_MODEL = "flux-dev"; // https://muapi.ai/playground/flux-dev/llms.txt
/** Video models whose request controls are verified by the shared capability registry. */
export const KNOWN_MUAPI_VIDEO_MODELS = CAMPAIGN_MODEL_CAPABILITIES.filter(
  (entry) => entry.connector === "muapi" && entry.kind === "video",
).map((entry) => entry.model);

const WHO = "MuAPI";
const NOT_CONFIGURED =
  "MuAPI has no key yet. Add one in Settings, Connections, Campaign Publishing.";
const UPLOAD_TIMEOUT = Duration.seconds(60);
const MODEL_SLUG = /^[A-Za-z0-9._-]+$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;
const DATA_ADDRESS = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s;
const EXTENSION_FOR: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const isImageToVideoModel = (slug: string): boolean =>
  slug.includes("i2v") || slug.includes("image-to-video");

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];

/** A figure the account answer states plainly, wherever the provider put it. */
const readBalance = (body: unknown): number | null => {
  const record = asRecord(body);
  const data = asRecord(record["data"]);
  for (const value of [record["balance"], data["balance"], record["credits"], data["credits"]]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

/**
 * MuAPI with the user's own key. Images and video are both asynchronous: submit to the model's
 * address, then poll by the bare request id. The id is checked before it is put in an address, so
 * the key only ever goes to api.muapi.ai.
 */
export function makeMuapiConnector(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<MuapiConfig | null>;
}): GenerationConnector {
  const headers = (config: MuapiConfig) => ({ "x-api-key": config.apiKey });

  /** Sends a picture the app holds as a data address to MuAPI and returns the link it hosts it at. */
  const upload = (config: MuapiConfig, dataAddress: string) =>
    Effect.gen(function* () {
      const failed = "MuAPI could not take the starting image, so the video was not started.";
      const match = DATA_ADDRESS.exec(dataAddress);
      if (match === null || !(match[2] ?? "").split(";").includes("base64")) {
        return yield* Effect.fail(failed);
      }
      const mime = (match[1] ?? "").toLowerCase() || "image/png";
      const bytes = Buffer.from(match[3] ?? "", "base64");
      if (bytes.length === 0) return yield* Effect.fail(failed);
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: mime }),
        `first-frame.${EXTENSION_FOR[mime] ?? "png"}`,
      );
      const reply = yield* callProvider(
        deps.http,
        HttpClientRequest.post(`${MUAPI_BASE}/upload_file`).pipe(
          HttpClientRequest.setHeaders(headers(config)),
          HttpClientRequest.bodyFormData(form),
        ),
        UPLOAD_TIMEOUT,
        WHO,
      ).pipe(Effect.mapError((reason) => `${failed} ${reason}`));
      if (reply.status < 200 || reply.status >= 300) {
        return yield* Effect.fail(`${failed} ${providerError(reply, WHO)}`);
      }
      // confirm against MuAPI's upload docs: the field name of the hosted link is not documented
      const body = asRecord(reply.body);
      const url = [body["url"], body["file_url"], asRecord(body["data"])["url"]].find(
        (value): value is string => typeof value === "string" && isHttpsUrl(value),
      );
      return url === undefined
        ? yield* Effect.fail(`${failed} MuAPI sent no link for the uploaded image.`)
        : url;
    });

  const start: GenerationConnector["start"] = (request: GenerationRequest) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      if (!MODEL_SLUG.test(request.model)) {
        return yield* Effect.fail(
          "The MuAPI model name has characters it cannot have. Check it in Settings.",
        );
      }
      const { options } = request;
      const capability = getCampaignModelCapability("muapi", request.model);
      if (capability === undefined)
        return yield* Effect.fail("Choose a supported model from the model list.");
      const optionError = campaignModelOptionsError(capability, request.kind, {
        ...options,
        ...(request.firstFrameUrl === undefined ? {} : { firstFrame: request.firstFrameUrl }),
      });
      if (optionError !== null) return yield* Effect.fail(optionError);
      let imageUrl: string | undefined;
      if (request.kind === "video") {
        const hasFrame = request.firstFrameUrl !== undefined && request.firstFrameUrl !== "";
        const imageToVideo = isImageToVideoModel(request.model);
        if (hasFrame && !imageToVideo) {
          return yield* Effect.fail(
            `${request.model} makes video from text only, but this video starts from a still image. Pick an image-to-video model in Settings.`,
          );
        }
        if (!hasFrame && imageToVideo) {
          return yield* Effect.fail(
            `${request.model} needs a starting image. Add a first frame, or pick a text-to-video model in Settings.`,
          );
        }
        const frame = request.firstFrameUrl;
        if (frame !== undefined && frame !== "") {
          if (isHttpsUrl(frame)) imageUrl = frame;
          else if (frame.startsWith("data:")) imageUrl = yield* upload(config, frame);
          else {
            return yield* Effect.fail(
              "The first frame must be an https link or an image file inside the thread's folder.",
            );
          }
        }
      }
      const reply = yield* postJson(
        deps.http,
        `${MUAPI_BASE}/${encodeURIComponent(request.model)}`,
        headers(config),
        {
          prompt: request.prompt,
          ...(imageUrl === undefined ? {} : { image_url: imageUrl }),
          ...(request.kind === "image"
            ? { ...campaignImageDimensions(options.aspectRatio), num_images: 1 }
            : options.aspectRatio === undefined
              ? {}
              : { aspect_ratio: options.aspectRatio }),
          ...(request.kind === "video" && options.durationSeconds !== undefined
            ? { duration: options.durationSeconds }
            : {}),
          ...(request.kind === "video" && options.resolution !== undefined
            ? { resolution: options.resolution }
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
      const body = asRecord(reply.body);
      const id = body["request_id"] ?? body["id"];
      if (typeof id !== "string" || !JOB_ID.test(id)) {
        return {
          kind: "uncertain",
          reason:
            "MuAPI accepted the request but sent no usable job id. Reconcile it on its usage page; this job will not be resubmitted.",
        } as const;
      }
      return { kind: "async", providerJobId: id } as const;
    });

  const poll: GenerationConnector["poll"] = (providerJobId) =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      if (!JOB_ID.test(providerJobId)) {
        return { state: "failed", reason: "The stored job id is not a MuAPI job id." } as const;
      }
      const reply = yield* getJson(
        deps.http,
        `${MUAPI_BASE}/predictions/${providerJobId}/result`,
        headers(config),
        SHORT,
        WHO,
      );
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
        return yield* Effect.fail("MuAPI sent a status this app cannot read.");
      if (status === "completed") {
        const urls = strings(body["outputs"]);
        return urls.length === 0
          ? ({ state: "failed", reason: "MuAPI did not return a video link." } as const)
          : ({ state: "done", urls: [urls[0] as string] } as const);
      }
      if (status === "failed" || status === "cancelled") {
        const error = body["error"];
        return {
          state: "failed",
          reason:
            typeof error === "string" && error.trim() !== ""
              ? `MuAPI said: ${error.trim().slice(0, 300)}`
              : `MuAPI reported the job as ${status}.`,
        } as const;
      }
      if (status === "queued" || status === "pending" || status === "processing") {
        return { state: "running" } as const;
      }
      return yield* Effect.fail("MuAPI sent a status this app cannot read.");
    });

  const test: GenerationConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as const;
      const reply = yield* getJson(
        deps.http,
        `${MUAPI_BASE}/account/balance`,
        headers(config),
        SHORT,
        WHO,
      );
      if (reply.status < 200 || reply.status >= 300) {
        return { ok: false, reason: providerError(reply, WHO) } as const;
      }
      // confirm against MuAPI's balance docs: where the figure sits in the answer
      const balance = readBalance(reply.body);
      return balance === null
        ? ({ ok: true } as const)
        : ({ ok: true, notes: `MuAPI reports a balance of ${balance}.` } as const);
    }).pipe(Effect.catch((reason: string) => Effect.succeed({ ok: false, reason } as const)));

  return {
    kind: "muapi",
    estimate: (request) =>
      estimateGenerationUsd({
        connector: "muapi",
        kind: request.kind,
        model: request.model,
        durationSeconds: request.options.durationSeconds,
      }),
    start,
    poll,
    test,
  };
}
