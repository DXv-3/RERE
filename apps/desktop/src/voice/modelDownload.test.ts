import * as NodeCrypto from "node:crypto";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Deferred, Effect, Exit, FileSystem, Fiber, Layer, Path } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeModelDownloader, type ModelDownloadProgress } from "./modelDownload.ts";

const bytes = (length: number) => new Uint8Array(length).map((_, index) => index % 251);
const sha256 = (data: Uint8Array) => NodeCrypto.createHash("sha256").update(data).digest("hex");

/** Serves `chunks` as the response body; `hold` keeps the body open after the last chunk. */
const server = (respond: () => Response, seen: { requests: number } = { requests: 0 }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.requests++;
        return HttpClientResponse.fromWeb(request, respond());
      }),
    ),
  );
const body = (data: Uint8Array, pieces = 4) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const size = Math.ceil(data.length / pieces);
        for (let at = 0; at < data.length; at += size)
          controller.enqueue(data.slice(at, at + size));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-length": String(data.length) } },
  );
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "dictation-download-test-" });
});
/** The message of the error an effect failed with, or "" when it did not fail. */
const failureMessage = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
  return error instanceof Error ? error.message : "";
};
const noProgress = () => Effect.void;

it.effect("streams to a .part file, checks it, and renames it into place", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* scratch, "whisper");
    const data = bytes(10_000);
    const progress: ModelDownloadProgress[] = [];
    const downloader = makeModelDownloader();

    const target = yield* downloader
      .download({
        url: "https://models.test/ggml-test.bin",
        directory,
        file: "ggml-test.bin",
        expectedBytes: data.length,
        sha256: sha256(data),
        onProgress: (value) => Effect.sync(() => void progress.push(value)),
      })
      .pipe(Effect.provide(server(() => body(data))));

    expect(target).toBe(path.join(directory, "ggml-test.bin"));
    expect(new Uint8Array(yield* fs.readFile(target))).toEqual(data);
    expect(yield* fs.exists(`${target}.part`)).toBe(false);
    expect(progress[0]).toEqual({ bytesDone: 0, bytesTotal: data.length });
    expect(progress.at(-1)).toEqual({ bytesDone: data.length, bytesTotal: data.length });
    expect(progress.map((p) => p.bytesDone)).toEqual(
      progress.map((p) => p.bytesDone).toSorted((a, b) => a - b),
    );
    expect(downloader.progress()).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not download a model that is already installed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* scratch;
    yield* fs.writeFileString(path.join(directory, "ggml-test.bin"), "already here");
    const seen = { requests: 0 };
    yield* makeModelDownloader()
      .download({
        url: "https://models.test/ggml-test.bin",
        directory,
        file: "ggml-test.bin",
        expectedBytes: 1,
        onProgress: noProgress,
      })
      .pipe(Effect.provide(server(() => body(bytes(10)), seen)));
    expect(seen.requests).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("removes the partial file when the download fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* scratch;
    const data = bytes(10_000);
    const downloader = makeModelDownloader();
    const request = {
      url: "https://models.test/ggml-test.bin",
      directory,
      file: "ggml-test.bin",
      expectedBytes: data.length,
      onProgress: noProgress,
    };
    const expectFailure = (
      layer: Layer.Layer<HttpClient.HttpClient>,
      message: RegExp,
      sha?: string,
    ) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          downloader
            .download({ ...request, ...(sha ? { sha256: sha } : {}) })
            .pipe(Effect.provide(layer)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toMatch(message);
        expect(yield* fs.readDirectory(directory)).toEqual([]);
        expect(downloader.progress()).toBeNull();
      });

    // The server stops sending partway: shorter than the length it promised.
    yield* expectFailure(
      server(
        () =>
          new Response(body(data.slice(0, 4000)).body, {
            status: 200,
            headers: { "content-length": String(data.length) },
          }),
      ),
      /ended early/,
    );
    // The bytes arrive in full but are not the published model.
    yield* expectFailure(
      server(() => body(data)),
      /did not match/,
      sha256(bytes(5)),
    );
    // The server refuses.
    yield* expectFailure(
      server(() => new Response("nope", { status: 503 })),
      /503/,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancelling removes the partial file and frees the downloader", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* scratch;
    const started = yield* Deferred.make<void>();
    const downloader = makeModelDownloader();
    const stalled = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes(1000));
          },
        }),
        { status: 200, headers: { "content-length": "5000" } },
      );
    const fiber = yield* downloader
      .download({
        url: "https://models.test/ggml-test.bin",
        directory,
        file: "ggml-test.bin",
        expectedBytes: 5000,
        onProgress: (p) =>
          p.bytesDone > 0 ? Deferred.succeed(started, undefined).pipe(Effect.asVoid) : Effect.void,
      })
      .pipe(Effect.provide(server(stalled)), Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);

    expect(yield* downloader.cancel).toBe(true);
    const exit = yield* Fiber.join(fiber);

    expect(failureMessage(exit)).toBe("Download cancelled.");
    expect(yield* fs.readDirectory(directory)).toEqual([]);
    expect(downloader.progress()).toBeNull();
    expect(yield* downloader.cancel).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses a second download while one is running", () =>
  Effect.gen(function* () {
    const directory = yield* scratch;
    const started = yield* Deferred.make<void>();
    const downloader = makeModelDownloader();
    const request = {
      url: "https://models.test/ggml-test.bin",
      directory,
      file: "ggml-test.bin",
      expectedBytes: 5000,
      onProgress: (p: ModelDownloadProgress) =>
        p.bytesDone > 0 ? Deferred.succeed(started, undefined).pipe(Effect.asVoid) : Effect.void,
    };
    const stalled = server(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes(1000));
            },
          }),
          { status: 200, headers: { "content-length": "5000" } },
        ),
    );
    const first = yield* downloader
      .download(request)
      .pipe(Effect.provide(stalled), Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);

    const second = yield* Effect.exit(downloader.download(request).pipe(Effect.provide(stalled)));
    expect(failureMessage(second)).toContain("already downloading");
    expect(downloader.progress()).toEqual({ bytesDone: 1000, bytesTotal: 5000 });

    yield* downloader.cancel;
    yield* Fiber.join(first);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
