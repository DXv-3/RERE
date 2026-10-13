import { estimateGenerationUsd } from "@t3tools/shared/campaignRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { GenerationConnector } from "./GenerationConnector.ts";
import { asRecord, getJson, postJson, providerError, SHORT } from "./generationHttp.ts";

export interface LocalConfig {
  readonly baseUrl: string;
  readonly model: string;
}

const WHO = "the local image server";
const NOT_CONFIGURED =
  "The local image server has no address yet. Add it in Settings, Connections, Campaign Publishing.";
const IMAGE_TIMEOUT = Duration.minutes(5);

/** The three sizes the OpenAI images API names; the nearest one to the aspect ratio. */
export const localImageSize = (aspectRatio: string | undefined): string => {
  switch (aspectRatio) {
    case "16:9":
    case "21:9":
    case "4:3":
      return "1792x1024";
    case "9:16":
    case "3:4":
      return "1024x1792";
    default:
      return "1024x1024";
  }
};

/** A local server that speaks the OpenAI images API. Images only; no key is needed. */
export function makeLocalImageConnector(deps: {
  readonly http: HttpClient.HttpClient;
  readonly config: Effect.Effect<LocalConfig | null>;
}): GenerationConnector {
  const start: GenerationConnector["start"] = (request) =>
    Effect.gen(function* () {
      if (request.kind === "video") {
        return yield* Effect.fail(
          "The local server makes images only. Choose OpenRouter or the marketing engine for video.",
        );
      }
      const config = yield* deps.config;
      if (config === null) return yield* Effect.fail(NOT_CONFIGURED);
      const reply = yield* postJson(
        deps.http,
        `${config.baseUrl}/v1/images/generations`,
        {},
        {
          model: request.model,
          prompt: request.prompt,
          size: localImageSize(request.options.aspectRatio),
          n: 1,
          response_format: "b64_json",
        },
        IMAGE_TIMEOUT,
        WHO,
      );
      if (reply.status < 200 || reply.status >= 300)
        return yield* Effect.fail(providerError(reply, WHO));
      const data = asRecord(reply.body)["data"];
      const first = asRecord(Array.isArray(data) ? data[0] : undefined);
      const b64 = first["b64_json"];
      if (typeof b64 === "string" && b64 !== "") {
        return { kind: "finished", urls: [`data:image/png;base64,${b64}`] } as const;
      }
      const url = first["url"];
      if (typeof url === "string" && url !== "") return { kind: "finished", urls: [url] } as const;
      return yield* Effect.fail("The local server answered but sent no image.");
    });

  const test: GenerationConnector["test"] = () =>
    Effect.gen(function* () {
      const config = yield* deps.config;
      if (config === null) return { ok: false, reason: NOT_CONFIGURED } as const;
      const reply = yield* getJson(deps.http, `${config.baseUrl}/v1/models`, {}, SHORT, WHO);
      return reply.status >= 200 && reply.status < 300
        ? ({ ok: true } as const)
        : ({ ok: false, reason: providerError(reply, WHO) } as const);
    }).pipe(Effect.catch((reason: string) => Effect.succeed({ ok: false, reason } as const)));

  return {
    kind: "local",
    estimate: (request) =>
      estimateGenerationUsd({ connector: "local", kind: request.kind, model: request.model }),
    start,
    // Every answer is immediate, so there is never anything to poll.
    poll: () =>
      Effect.succeed({ state: "failed", reason: "The local server has no jobs to poll." }),
    test,
  };
}
