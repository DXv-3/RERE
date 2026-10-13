import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

/** A finished video can be large; an image from a provider never is. */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** The file extension for an image or video content type, or null for anything else. */
export function extensionForContentType(contentType: string | undefined): string | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSIONS[type] ?? null;
}

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[.*\])$/i;

/** True for an https address on a public host. Provider-sent addresses are never fetched otherwise. */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && !PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export interface Downloaded {
  readonly extension: string;
  readonly bytes: number;
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Saves one result at `basePath` plus an extension. Accepts an https address on a public host, or
 * an inline image. Refuses anything that is not an image or video, or is over the size limit, and
 * never leaves a partial file behind.
 */
export const downloadResult = (
  deps: {
    readonly http: HttpClient.HttpClient;
    readonly fileSystem: FileSystem.FileSystem;
  },
  url: string,
  basePath: string,
  limits: { readonly maxBytes?: number } = {},
): Effect.Effect<Downloaded, string> =>
  Effect.gen(function* () {
    const maxBytes = limits.maxBytes ?? MAX_DOWNLOAD_BYTES;
    const { fileSystem } = deps;
    if (url.startsWith("data:")) {
      const match = DATA_URL.exec(url);
      const extension = extensionForContentType(match?.[1]);
      if (match === null || extension === null || !match[1]?.toLowerCase().startsWith("image/")) {
        return yield* Effect.fail("The provider sent an inline file that is not an image.");
      }
      const bytes = Uint8Array.from(Buffer.from((match[2] ?? "").replace(/\s/g, ""), "base64"));
      if (bytes.byteLength === 0 || bytes.byteLength > Math.min(maxBytes, MAX_IMAGE_BYTES)) {
        return yield* Effect.fail("The provider's image was empty or too large to save.");
      }
      yield* fileSystem
        .writeFile(`${basePath}.${extension}`, bytes)
        .pipe(Effect.mapError(() => "The image could not be saved."));
      return { extension, bytes: bytes.byteLength };
    }
    if (!isPublicHttpsUrl(url)) {
      return yield* Effect.fail(
        "The provider sent a result address that is not a public https link, so it was not downloaded.",
      );
    }
    const response = yield* deps.http
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.mapError(() => "The result could not be downloaded."));
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(`The result could not be downloaded (HTTP ${response.status}).`);
    }
    const extension = extensionForContentType(response.headers["content-type"]);
    if (extension === null) {
      return yield* Effect.fail("The result is not an image or video file, so it was not saved.");
    }
    const declared = Number(response.headers["content-length"] ?? "0");
    if (declared > maxBytes) {
      return yield* Effect.fail("The result is larger than the 500 MB limit, so it was not saved.");
    }
    const part = `${basePath}.${extension}.part`;
    const seen = yield* Ref.make(0);
    const finalPath = `${basePath}.${extension}`;
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Ref.updateAndGet(seen, (total) => total + chunk.byteLength).pipe(
          Effect.flatMap((total) =>
            total > maxBytes ? Effect.fail("too-large" as const) : Effect.void,
          ),
        ),
      ),
      Stream.run(fileSystem.sink(part)),
      Effect.flatMap(() => fileSystem.rename(part, finalPath)),
      Effect.tapError(() => fileSystem.remove(part, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((error) =>
        error === "too-large"
          ? "The result is larger than the 500 MB limit, so it was not saved."
          : "The result could not be downloaded.",
      ),
    );
    return { extension, bytes: yield* Ref.get(seen) };
  });
