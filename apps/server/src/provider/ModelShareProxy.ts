/**
 * The endpoint a model share points someone's own Claude provider at
 * (`ANTHROPIC_BASE_URL`). It speaks the three Anthropic routes that provider
 * uses and forwards them to the shared provider's endpoint with this
 * environment's credentials. The share token is the only thing it accepts: a
 * pairing session or cookie is not a share, and a share is not a session.
 */
import { MODEL_SHARE_ROUTE_PREFIX, type ModelShare } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ModelShares from "./ModelShares.ts";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = ["accept", "anthropic-beta", "anthropic-version", "content-type"];
const POST_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const errorResponse = (status: number, type: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

/** The token from `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN) or `x-api-key` (ANTHROPIC_API_KEY). */
export function readShareToken(headers: Readonly<Record<string, string | undefined>>) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? "")?.[1];
  return bearer ?? headers["x-api-key"]?.trim() ?? "";
}

/**
 * The request body with a model this share serves. A Claude client also asks
 * for models of its own (a small one for titles and summaries), which the
 * shared endpoint does not have, so anything outside the share is answered by
 * the share's first model rather than refused.
 */
export function pinSharedModel(body: string, models: ReadonlyArray<string>): string | null {
  const parsed = decodeJsonObject(body);
  const fallback = models[0];
  if (Option.isNone(parsed) || fallback === undefined) return null;
  const requested = parsed.value.model;
  if (typeof requested === "string" && models.includes(requested)) return body;
  return encodeJson({ ...parsed.value, model: fallback });
}

/** The Anthropic `GET /v1/models` list for a share, so the client can discover what it may use. */
export function sharedModelList(share: Pick<ModelShare, "models" | "createdAt">) {
  return {
    data: share.models.map((id) => ({
      type: "model",
      id,
      display_name: id,
      created_at: share.createdAt,
    })),
    has_more: false,
    first_id: share.models[0] ?? null,
    last_id: share.models.at(-1) ?? null,
  };
}

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return errorResponse(400, "invalid_request_error", "Bad request.");
  }
  const shares = yield* ModelShares.ModelShares;
  const share = yield* shares
    .authorize(readShareToken(request.headers))
    .pipe(Effect.orElseSucceed(() => Option.none<ModelShare>()));
  if (Option.isNone(share)) {
    return errorResponse(401, "authentication_error", "This model share is not valid.");
  }

  const sharePath = url.value.pathname.slice(MODEL_SHARE_ROUTE_PREFIX.length);
  if (request.method === "GET" && sharePath === "/v1/models") {
    return HttpServerResponse.jsonUnsafe(sharedModelList(share.value), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (request.method !== "POST" || !POST_PATHS.has(sharePath)) {
    return errorResponse(404, "not_found_error", "This model share does not serve that route.");
  }
  if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
    return errorResponse(413, "request_too_large", "The request is too large.");
  }

  const body = yield* request.text.pipe(
    Effect.map((text) => pinSharedModel(text, share.value.models)),
    Effect.orElseSucceed(() => null),
  );
  if (body === null) {
    return errorResponse(400, "invalid_request_error", "The request body is not a JSON object.");
  }

  const upstream = yield* shares.resolveUpstream(share.value).pipe(Effect.option);
  if (Option.isNone(upstream)) {
    return errorResponse(503, "api_error", "The shared model is not available right now.");
  }

  const headers: Record<string, string> = { ...upstream.value.headers };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* httpClient
    .execute(
      HttpClientRequest.post(`${upstream.value.baseUrl}${sharePath}${url.value.search}`).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyText(body, headers["content-type"] ?? "application/json"),
      ),
    )
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("model share upstream request failed", {
          shareId: share.value.id,
          providerInstanceId: share.value.providerInstanceId,
          cause,
        }),
      ),
      Effect.option,
    );
  if (Option.isNone(response)) {
    return errorResponse(502, "api_error", "The shared model did not answer.");
  }

  const contentType = response.value.headers["content-type"];
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    // Token streams must reach the client as they are produced, not once compression fills a buffer.
    headers: { "cache-control": "no-store, no-transform" },
    ...(contentType ? { contentType } : {}),
  });
});

export const modelShareProxyRouteLayer = HttpRouter.add(
  "*",
  `${MODEL_SHARE_ROUTE_PREFIX}/*`,
  handler,
);
