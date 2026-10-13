// @effect-diagnostics nodeBuiltinImport:off - the upload test streams a real file and makes a sparse one for the size limit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  contentTypeFor,
  makeS3Uploader,
  normalizeHttpsOrigin,
  normalizePublicBaseUrl,
  objectKey,
  publicUrlFor,
  safeFileName,
  slugify,
  STORAGE_MAX_FILE_BYTES,
  type StorageCredentials,
  type StorageTarget,
} from "./S3Uploader.ts";
import { signRequest, UNSIGNED_PAYLOAD } from "./sigv4.ts";

const TARGET: StorageTarget = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "media",
  publicBaseUrl: "https://files.example.com",
  prefix: "campaigns/",
};
const CREDENTIALS: StorageCredentials = {
  accessKeyId: "AKIDEXAMPLE0000",
  secretAccessKey: "super-secret-value-do-not-leak",
};
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

let directory = "";
beforeAll(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-s3-"));
  NodeFS.writeFileSync(NodePath.join(directory, "clip.mp4"), "0123456789");
  const big = NodePath.join(directory, "big.mp4");
  NodeFS.writeFileSync(big, "");
  NodeFS.truncateSync(big, STORAGE_MAX_FILE_BYTES + 1);
});
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type Reply = number | "network-error";

const fakeHttp = (reply: Reply = 200) => {
  const seen: Seen[] = [];
  const http = HttpClient.make((req: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const body =
        req.body._tag === "Stream"
          ? new TextDecoder().decode(
              Buffer.concat(yield* req.body.stream.pipe(Stream.orDie, Stream.runCollect)),
            )
          : req.body._tag === "Uint8Array"
            ? new TextDecoder().decode(req.body.body)
            : "";
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      if (reply === "network-error") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req }),
        });
      }
      return HttpClientResponse.fromWeb(req, new Response(null, { status: reply }));
    }),
  );
  return { http, seen };
};

const uploader = (reply: Reply = 200) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fake = fakeHttp(reply);
    yield* TestClock.setTime(NOW);
    return { ...fake, uploader: makeS3Uploader({ http: fake.http, fileSystem }) };
  });

describe("addresses and names", () => {
  it("builds the key as prefix, client, campaign, post and file", () => {
    assert.strictEqual(
      objectKey({
        prefix: "campaigns/",
        clientSlug: slugify("Candid Studios", "c1"),
        campaignSlug: slugify("Fall Reels!", "k1"),
        postId: "post_1",
        fileName: safeFileName("My Clip (final).mp4"),
      }),
      "campaigns/candid-studios/fall-reels/post_1/My-Clip-final-.mp4",
    );
    assert.strictEqual(slugify("???", "fallback"), "fallback");
    assert.strictEqual(
      objectKey({
        prefix: "",
        clientSlug: "a",
        campaignSlug: "b",
        postId: "p",
        fileName: "f.mp4",
      }),
      "a/b/p/f.mp4",
    );
  });

  it("never lets a file name carry a path or a hidden file name", () => {
    assert.strictEqual(safeFileName("../../.env"), "env");
    assert.strictEqual(safeFileName(""), "file");
  });

  it("serves from the public base address, with the key encoded", () => {
    assert.strictEqual(
      publicUrlFor(TARGET, "campaigns/a b/clip.mp4"),
      "https://files.example.com/campaigns/a%20b/clip.mp4",
    );
    assert.strictEqual(
      publicUrlFor({ publicBaseUrl: "https://cdn.example.com/m/" }, "k/x.mp4"),
      "https://cdn.example.com/m/k/x.mp4",
    );
  });

  it("accepts only https addresses without logins", () => {
    assert.strictEqual(
      normalizeHttpsOrigin("https://acct.r2.cloudflarestorage.com/"),
      "https://acct.r2.cloudflarestorage.com",
    );
    for (const bad of [
      "http://acct.r2.cloudflarestorage.com",
      "https://u:p@x.test",
      "https://x.test/bucket",
      "https://x.test?a=1",
      "x.test",
    ]) {
      assert.isNull(normalizeHttpsOrigin(bad), bad);
    }
    assert.strictEqual(normalizePublicBaseUrl("https://cdn.test/m/"), "https://cdn.test/m");
    assert.isNull(normalizePublicBaseUrl("http://cdn.test"));
  });

  it("sets the content type from the extension and refuses unknown ones", () => {
    assert.strictEqual(contentTypeFor(".MP4"), "video/mp4");
    assert.strictEqual(contentTypeFor(".jpg"), "image/jpeg");
    assert.isNull(contentTypeFor(".env"));
    assert.isNull(contentTypeFor(".pdf"));
  });
});

describe("S3Uploader", () => {
  it.layer(NodeServices.layer)("requests", (it) => {
    it.effect("streams a file with a path-style signed PUT", () =>
      Effect.gen(function* () {
        const { uploader: up, seen } = yield* uploader();
        const key = "campaigns/candid/reels/post_1/clip.mp4";
        yield* up.putFile({
          target: TARGET,
          credentials: CREDENTIALS,
          key,
          filePath: NodePath.join(directory, "clip.mp4"),
          contentType: "video/mp4",
        });
        assert.lengthOf(seen, 1);
        const request = seen[0]!;
        assert.strictEqual(request.method, "PUT");
        assert.strictEqual(request.url, `${TARGET.endpoint}/media/${key}`);
        assert.strictEqual(request.body, "0123456789");
        assert.strictEqual(request.headers["content-type"], "video/mp4");
        assert.strictEqual(request.headers["content-length"], "10");
        assert.strictEqual(request.headers["x-amz-content-sha256"], UNSIGNED_PAYLOAD);
        assert.strictEqual(request.headers["x-amz-date"], "20261006T120000Z");
        assert.strictEqual(request.headers["host"], undefined);

        // The signature is the one the pure signer gives for this exact request.
        const expected = signRequest({
          method: "PUT",
          canonicalUri: `/media/${key}`,
          headers: {
            host: "acct123.r2.cloudflarestorage.com",
            "x-amz-content-sha256": UNSIGNED_PAYLOAD,
            "x-amz-date": "20261006T120000Z",
            "content-type": "video/mp4",
          },
          payloadHash: UNSIGNED_PAYLOAD,
          accessKeyId: CREDENTIALS.accessKeyId,
          secretAccessKey: CREDENTIALS.secretAccessKey,
          region: "auto",
          at: NOW,
        });
        assert.strictEqual(request.headers["authorization"], expected.authorization);
        // Pinned (and checked by hand with an independent HMAC chain), so a change to what is
        // signed shows up here.
        assert.strictEqual(
          expected.signature,
          "4d04a9b682681226e0ac46417f1a9845c5eeb0b74a1938a4920324d45f3e8042",
        );
        assert.include(
          request.headers["authorization"] ?? "",
          "Credential=AKIDEXAMPLE0000/20261006/auto/s3/aws4_request,SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,",
        );
        // The secret is never sent.
        assert.notInclude(
          [request.url, request.body, ...Object.values(request.headers)].join("\n"),
          CREDENTIALS.secretAccessKey,
        );
      }),
    );

    it.effect("encodes a key with spaces and signs the same encoded path", () =>
      Effect.gen(function* () {
        const { uploader: up, seen } = yield* uploader();
        yield* up.putBytes({
          target: TARGET,
          credentials: CREDENTIALS,
          key: "campaigns/a b/it's.txt",
          bytes: new TextEncoder().encode("hi"),
          contentType: "text/plain",
        });
        assert.strictEqual(seen[0]?.url, `${TARGET.endpoint}/media/campaigns/a%20b/it%27s.txt`);
        // A small body is signed with its real hash, not left unsigned.
        assert.strictEqual(
          seen[0]?.headers["x-amz-content-sha256"],
          "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
        );
      }),
    );

    it.effect("deletes with a signed DELETE", () =>
      Effect.gen(function* () {
        const { uploader: up, seen } = yield* uploader(204);
        yield* up.remove({ target: TARGET, credentials: CREDENTIALS, key: "campaigns/x.txt" });
        assert.strictEqual(seen[0]?.method, "DELETE");
        assert.strictEqual(seen[0]?.url, `${TARGET.endpoint}/media/campaigns/x.txt`);
        assert.include(seen[0]?.headers["authorization"] ?? "", "AWS4-HMAC-SHA256");
      }),
    );

    it.effect("says in plain words why a request failed", () =>
      Effect.gen(function* () {
        const message = (reply: Reply) =>
          Effect.gen(function* () {
            const { uploader: up } = yield* uploader(reply);
            const error = yield* up
              .putBytes({
                target: TARGET,
                credentials: CREDENTIALS,
                key: "k.txt",
                bytes: new Uint8Array([1]),
                contentType: "text/plain",
              })
              .pipe(Effect.flip);
            return error.message;
          });
        assert.include(yield* message(403), "refused the keys");
        assert.include(yield* message(404), "bucket was not found");
        assert.include(yield* message(500), "had a problem");
        assert.include(yield* message("network-error"), "Could not reach the storage service");
        // No failure message contains a key.
        for (const reply of [403, 404, 500, "network-error"] as const) {
          const text = yield* message(reply);
          assert.notInclude(text, CREDENTIALS.secretAccessKey);
          assert.notInclude(text, CREDENTIALS.accessKeyId);
        }
      }),
    );

    it.effect("refuses a file over 2 GB without sending anything", () =>
      Effect.gen(function* () {
        const { uploader: up, seen } = yield* uploader();
        const error = yield* up
          .putFile({
            target: TARGET,
            credentials: CREDENTIALS,
            key: "k.mp4",
            filePath: NodePath.join(directory, "big.mp4"),
            contentType: "video/mp4",
          })
          .pipe(Effect.flip);
        assert.include(error.message, "over 2 GB");
        assert.lengthOf(seen, 0);
      }),
    );

    it.effect("reports a file that cannot be read", () =>
      Effect.gen(function* () {
        const { uploader: up } = yield* uploader();
        const error = yield* up
          .putFile({
            target: TARGET,
            credentials: CREDENTIALS,
            key: "k.mp4",
            filePath: NodePath.join(directory, "missing.mp4"),
            contentType: "video/mp4",
          })
          .pipe(Effect.flip);
        assert.include(error.message, "could not be read");
      }),
    );
  });
});
