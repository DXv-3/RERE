import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { amzDates, encodePath, sha256Hex, signRequest, UNSIGNED_PAYLOAD } from "./sigv4.ts";

/**
 * Puts files into an S3-compatible bucket (Cloudflare R2, Amazon S3, MinIO, Backblaze B2) with
 * AWS Signature V4, and works out the public address each one will have. Path-style addressing
 * (`https://<endpoint>/<bucket>/<key>`) because R2 and the other services accept it everywhere.
 * Nothing in here logs or returns a key.
 */

/** Nothing bigger than this is uploaded. */
export const STORAGE_MAX_FILE_BYTES = 2_000_000_000;

export interface StorageTarget {
  /** https origin, no path. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  /** https address files are served from, no trailing slash. */
  readonly publicBaseUrl: string;
  /** In front of every key; empty or ending in a slash. */
  readonly prefix: string;
}

export interface StorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** A failure in words for a person to read. Never carries a key. */
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  message: Schema.String,
}) {}

const failure = (message: string) => new StorageFailure({ message });

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
};

/** The type a browser is told, from the file's extension. Null for anything not allowed up. */
export function contentTypeFor(extension: string): string | null {
  return CONTENT_TYPES[extension.toLowerCase()] ?? null;
}

/** Lower-case letters, digits, dot, dash and underscore; everything else becomes a dash. */
export function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return slug === "" ? fallback : slug;
}

/** A file's name as it will appear in the address: its own letters, never a path. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-120);
  return cleaned === "" ? "file" : cleaned;
}

export function objectKey(input: {
  readonly prefix: string;
  readonly clientSlug: string;
  readonly campaignSlug: string;
  readonly postId: string;
  readonly fileName: string;
}): string {
  const prefix = input.prefix.replace(/^\/+/, "");
  const lead = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
  return `${lead}${input.clientSlug}/${input.campaignSlug}/${input.postId}/${input.fileName}`;
}

export function publicUrlFor(target: Pick<StorageTarget, "publicBaseUrl">, key: string): string {
  return `${target.publicBaseUrl.replace(/\/+$/, "")}/${encodePath(key)}`;
}

/** The origin of a storage address, or null when it is not a plain https address. */
export function normalizeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return null;
    }
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A public base address: https, no login, no query; a path is allowed. */
export function normalizePublicBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

const reasonFor = (status: number, action: string): string => {
  if (status === 401 || status === 403) {
    return `The storage service refused the keys (HTTP ${status}). Check the access key and secret, and that they are allowed to write to the bucket.`;
  }
  if (status === 404) {
    return `The storage service says the bucket was not found (HTTP 404). Check the bucket name and the address.`;
  }
  if (status === 301 || status === 307 || status === 400) {
    return `The storage service did not accept the request (HTTP ${status}). Check the address and the region.`;
  }
  if (status === 413) return "The storage service says the file is too large.";
  if (status === 429 || status >= 500) {
    return `The storage service had a problem (HTTP ${status}) while ${action}. Try again in a little while.`;
  }
  return `The storage service answered HTTP ${status} while ${action}.`;
};

export interface S3Uploader {
  /** Streams the file to `key`. Returns once the service has it. */
  readonly putFile: (input: {
    readonly target: StorageTarget;
    readonly credentials: StorageCredentials;
    readonly key: string;
    readonly filePath: string;
    readonly contentType: string;
  }) => Effect.Effect<void, StorageFailure>;
  readonly putBytes: (input: {
    readonly target: StorageTarget;
    readonly credentials: StorageCredentials;
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }) => Effect.Effect<void, StorageFailure>;
  readonly remove: (input: {
    readonly target: StorageTarget;
    readonly credentials: StorageCredentials;
    readonly key: string;
  }) => Effect.Effect<void, StorageFailure>;
  /** The status the public address answers with, for the connection test. */
  readonly publicStatus: (url: string) => Effect.Effect<number, StorageFailure>;
}

export function makeS3Uploader(deps: {
  readonly http: HttpClient.HttpClient;
  readonly fileSystem: FileSystem.FileSystem;
}): S3Uploader {
  /** Signs and sends one request; the body, if any, is set by `withBody`. */
  const send = (input: {
    readonly method: "PUT" | "DELETE";
    readonly target: StorageTarget;
    readonly credentials: StorageCredentials;
    readonly key: string;
    readonly contentType?: string;
    readonly payloadHash: string;
    readonly withBody: (
      request: HttpClientRequest.HttpClientRequest,
    ) => HttpClientRequest.HttpClientRequest;
    readonly timeout: Duration.Duration;
    readonly action: string;
  }) =>
    Effect.gen(function* () {
      const origin = new URL(input.target.endpoint);
      const canonicalUri = `/${encodePath(`${input.target.bucket}/${input.key}`)}`;
      const at = yield* Clock.currentTimeMillis;
      const { amzDate } = amzDates(at);
      const headers: Record<string, string> = {
        host: origin.host,
        "x-amz-content-sha256": input.payloadHash,
        "x-amz-date": amzDate,
        ...(input.contentType === undefined ? {} : { "content-type": input.contentType }),
      };
      const signed = signRequest({
        method: input.method,
        canonicalUri,
        headers,
        payloadHash: input.payloadHash,
        accessKeyId: input.credentials.accessKeyId,
        secretAccessKey: input.credentials.secretAccessKey,
        region: input.target.region,
        at,
      });
      // `host` is set by the HTTP client from the address; every other signed header goes out.
      const { host: _host, ...sent } = headers;
      const request = input.withBody(
        HttpClientRequest.make(input.method)(`${origin.origin}${canonicalUri}`).pipe(
          HttpClientRequest.setHeaders({ ...sent, authorization: signed.authorization }),
        ),
      );
      const response = yield* deps.http.execute(request).pipe(
        Effect.timeout(input.timeout),
        Effect.mapError((error) =>
          failure(
            error._tag === "TimeoutError"
              ? "The storage service did not answer in time."
              : "Could not reach the storage service. Check the address.",
          ),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* failure(reasonFor(response.status, input.action));
      }
    });

  const putFile: S3Uploader["putFile"] = (input) =>
    Effect.gen(function* () {
      const info = yield* deps.fileSystem
        .stat(input.filePath)
        .pipe(Effect.mapError(() => failure("The file could not be read.")));
      const size = Number(info.size);
      if (size > STORAGE_MAX_FILE_BYTES) {
        return yield* failure("This file is over 2 GB, which is more than will be uploaded.");
      }
      // A minute plus a second per megabyte, so a slow line still finishes and a stuck one ends.
      const timeout = Duration.seconds(Math.min(3600, 60 + Math.ceil(size / 1_000_000)));
      yield* send({
        method: "PUT",
        target: input.target,
        credentials: input.credentials,
        key: input.key,
        contentType: input.contentType,
        payloadHash: UNSIGNED_PAYLOAD,
        withBody: (request) =>
          request.pipe(
            HttpClientRequest.bodyStream(deps.fileSystem.stream(input.filePath), {
              contentType: input.contentType,
              contentLength: size,
            }),
          ),
        timeout,
        action: "uploading",
      });
    });

  const putBytes: S3Uploader["putBytes"] = (input) =>
    send({
      method: "PUT",
      target: input.target,
      credentials: input.credentials,
      key: input.key,
      contentType: input.contentType,
      payloadHash: sha256Hex(input.bytes),
      withBody: (request) =>
        request.pipe(HttpClientRequest.bodyUint8Array(input.bytes, input.contentType)),
      timeout: Duration.seconds(30),
      action: "uploading",
    });

  const remove: S3Uploader["remove"] = (input) =>
    send({
      method: "DELETE",
      target: input.target,
      credentials: input.credentials,
      key: input.key,
      payloadHash: sha256Hex(""),
      withBody: (request) => request,
      timeout: Duration.seconds(30),
      action: "deleting",
    });

  const publicStatus: S3Uploader["publicStatus"] = (url) =>
    deps.http.execute(HttpClientRequest.get(url)).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.map((response) => response.status),
      Effect.mapError(() => failure("Could not reach the public address.")),
    );

  return { putFile, putBytes, remove, publicStatus };
}
