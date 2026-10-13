import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class ChatGptCatalogError extends Schema.TaggedError<ChatGptCatalogError>()(
  "ChatGptCatalogError",
  { status: Schema.Int },
) {}

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.String,
    }),
  ),
});

/** Account choices come from OpenAI; native model/list contributes capability metadata only. */
export const chatGptModels = Effect.fn("chatGptModels")(function* (
  accessToken: string,
  nativeModels: ReadonlyArray<ServerProviderModel>,
  codexVersion?: string | null,
) {
  const http = yield* HttpClient.HttpClient;
  // OpenAI lists a model only to clients new enough to run it, so the request names the Codex
  // version in use, as Codex itself does. Without it the answer is the list for the oldest
  // clients and newer models never appear.
  const version = /^\d+\.\d+\.\d+$/.test(codexVersion ?? "") ? codexVersion : null;
  const response = yield* http.execute(
    HttpClientRequest.get("https://api.openai.com/v1/models").pipe(
      version ? HttpClientRequest.setUrlParam("client_version", version) : (request) => request,
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (response.status !== 200) return yield* new ChatGptCatalogError({ status: response.status });
  const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
  return catalog.models
    .filter((model) => model.visibility === "list")
    .map(
      (model) =>
        ({
          ...nativeModels.find((native) => native.slug === model.slug),
          capabilities:
            nativeModels.find((native) => native.slug === model.slug)?.capabilities ?? null,
          slug: model.slug,
          name: model.display_name,
          isCustom: false,
        }) satisfies ServerProviderModel,
    );
}, Effect.timeout("15 seconds"));
