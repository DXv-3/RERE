import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { statMediaFile, streamMediaFile } from "../../assets/MediaFile.ts";
import { assetByteRange } from "../../http.ts";
import {
  CAMPAIGN_MEDIA_ROUTE_PREFIX,
  CampaignMediaLinks,
  type MediaLinkOutcome,
} from "./CampaignMediaLinks.ts";

/** The same plain answer for every way a link can be wrong, so nothing can be learned from it. */
const notFound = () =>
  HttpServerResponse.text("Not Found", {
    status: 404,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/**
 * One file for a platform or a person that has its link: the bytes with the type the server
 * recorded for it, ranges for video players, and nothing that could make a browser treat it as a page.
 */
export const campaignMediaResponse = Effect.fn("campaignMediaResponse")(function* (
  link: Extract<MediaLinkOutcome, { readonly _tag: "Ready" }>,
  request: {
    readonly method: "GET" | "HEAD";
    readonly range: string | undefined;
    readonly ifRange: string | undefined;
  },
) {
  const info = yield* statMediaFile(link.path, link.file);
  const headers: Record<string, string> = {
    "Content-Type": link.contentType,
    "Content-Disposition": `inline; filename="${link.fileName}"`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  let status = 200;
  let offset = 0n;
  let size = info.size;
  // A range with an If-Range cannot be checked (the file has no validator), so it is a full answer.
  if (request.method === "GET" && request.range !== undefined && request.ifRange === undefined) {
    const range = assetByteRange(request.range, info.size);
    if (range?._tag === "Unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${info.size}` },
      });
    }
    if (range?._tag === "Range") {
      status = 206;
      offset = range.offset;
      size = range.bytesToRead;
      headers["Content-Range"] = range.contentRange;
    }
  }
  headers["Content-Length"] = String(size);
  if (request.method === "HEAD" || size === 0n)
    return HttpServerResponse.empty({ status, headers });
  const body = streamMediaFile(link.file, offset, size);
  return body === null
    ? notFound()
    : HttpServerResponse.stream(body, { status, headers, contentLength: Number(size) });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return notFound();
  // `<token>/<file name>`. The name is only for show; nothing but the token is looked up.
  const parts = url.value.pathname.slice(`${CAMPAIGN_MEDIA_ROUTE_PREFIX}/`.length).split("/");
  const token = parts[0];
  if (token === undefined || parts.length !== 2) return notFound();
  const links = yield* CampaignMediaLinks;
  const outcome = yield* links.open({
    token,
    remoteAddress: Option.getOrNull(request.remoteAddress),
  });
  if (outcome._tag === "NotFound") return notFound();
  if (outcome._tag === "Limited") {
    return HttpServerResponse.text("Too Many Requests", {
      status: 429,
      headers: { "retry-after": "60", "cache-control": "no-store" },
    });
  }
  return yield* campaignMediaResponse(outcome, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    range: request.headers.range,
    ifRange: request.headers["if-range"],
  }).pipe(Effect.orElseSucceed(notFound));
});

/** Public by design: the secret in the address is the only credential. The router answers HEAD from GET. */
export const campaignMediaRouteLayer = HttpRouter.add(
  "GET",
  `${CAMPAIGN_MEDIA_ROUTE_PREFIX}/*`,
  handler,
);
