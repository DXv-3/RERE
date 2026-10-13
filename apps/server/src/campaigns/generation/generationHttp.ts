import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export interface ProviderReply {
  readonly status: number;
  readonly body: unknown;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * One request to a provider. Nothing is retried: a request that timed out or was answered may
 * already have been billed, and a second one would be billed again.
 */
export const callProvider = (
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  timeout: Duration.Duration,
  who: string,
): Effect.Effect<ProviderReply, string> =>
  http.execute(request).pipe(
    Effect.flatMap((response) =>
      response.json.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map((body): ProviderReply => ({ status: response.status, body })),
      ),
    ),
    Effect.timeout(timeout),
    Effect.mapError((error) =>
      error._tag === "TimeoutError"
        ? `${who} did not answer in time. It may still have run: check ${who}'s usage before starting it again.`
        : error._tag === "HttpClientError" && error.reason._tag === "TransportError"
          ? `Could not reach ${who}.`
          : `The request to ${who} failed.`,
    ),
  );

export const postJson = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
  timeout: Duration.Duration,
  who: string,
): Effect.Effect<ProviderReply, string> =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyJson(body),
    Effect.mapError(() => `The request to ${who} could not be built.`),
    Effect.flatMap((request) => callProvider(http, request, timeout, who)),
  );

export const getJson = (
  http: HttpClient.HttpClient,
  url: string,
  headers: Readonly<Record<string, string>>,
  timeout: Duration.Duration,
  who: string,
) =>
  callProvider(
    http,
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)),
    timeout,
    who,
  );

/** The provider's own words for what went wrong, else the HTTP status. Never includes a request. */
export const providerError = (reply: ProviderReply, who: string): string => {
  const body = asRecord(reply.body);
  const nested = asRecord(body["error"])["message"];
  const message = typeof nested === "string" ? nested : body["error"];
  const text = typeof message === "string" ? message.trim().slice(0, 300) : "";
  return text === "" ? `${who} answered with HTTP ${reply.status}.` : `${who} said: ${text}`;
};

export const SHORT = Duration.seconds(15);
