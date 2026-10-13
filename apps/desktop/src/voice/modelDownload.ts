import * as NodeCrypto from "node:crypto";
import { Deferred, Effect, Exit, FileSystem, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";

export class ModelDownloadError extends Schema.TaggedError<ModelDownloadError>()(
  "ModelDownloadError",
  { message: Schema.String },
) {}

export interface ModelDownloadProgress {
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface ModelDownloadRequest {
  readonly url: string;
  readonly directory: string;
  readonly file: string;
  /** Used for progress until the server reports the real size. */
  readonly expectedBytes: number;
  /** When given, the finished file must hash to this before it is installed. */
  readonly sha256?: string;
  readonly onProgress: (progress: ModelDownloadProgress) => Effect.Effect<void>;
}

const isModelDownloadError = Schema.is(ModelDownloadError);
const fail = (message: string) => new ModelDownloadError({ message });

/**
 * Downloads one model file at a time: streamed to `<file>.part`, checked, then renamed
 * into place, so a half-finished download is never mistaken for a model. A failed or
 * cancelled download removes its `.part` file. `onProgress` is called at about every half percent.
 */
export function makeModelDownloader() {
  let active: { cancel: Deferred.Deferred<void>; progress: ModelDownloadProgress } | null = null;

  const transfer = Effect.fn(function* (request: ModelDownloadRequest) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
    const target = path.join(request.directory, request.file);
    const part = `${target}.part`;
    if (yield* fs.exists(target)) return target;
    yield* fs.makeDirectory(request.directory, { recursive: true });
    return yield* Effect.gen(function* () {
      const response = yield* client
        .get(request.url)
        .pipe(
          Effect.mapError(() =>
            fail("Could not reach the download server. Check your connection."),
          ),
        );
      if (response.status !== 200) {
        return yield* fail(`The download server answered ${response.status}. Try again later.`);
      }
      const reported = Number(response.headers["content-length"]);
      const total = reported > 0 ? reported : request.expectedBytes;
      const hash = NodeCrypto.createHash("sha256");
      let done = 0;
      let announced = 0;
      const publish = (progress: ModelDownloadProgress) => {
        if (active) active.progress = progress;
        return request.onProgress(progress);
      };
      yield* publish({ bytesDone: 0, bytesTotal: total });
      yield* response.stream.pipe(
        Stream.mapError(() => fail("The download was interrupted. Try again.")),
        Stream.tap((chunk) => {
          hash.update(chunk);
          done += chunk.byteLength;
          if (done - announced < total / 200) return Effect.void;
          announced = done;
          return publish({ bytesDone: done, bytesTotal: total });
        }),
        Stream.run(fs.sink(part)),
      );
      if (reported > 0 && done !== reported) {
        return yield* fail("The download ended early. Try again.");
      }
      if (request.sha256 && hash.digest("hex") !== request.sha256) {
        return yield* fail("The downloaded file did not match the published model. Try again.");
      }
      yield* fs.rename(part, target);
      yield* publish({ bytesDone: done, bytesTotal: Math.max(done, total) });
      return target;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : fs.remove(part, { force: true }).pipe(Effect.ignore),
      ),
    );
  });

  const download = (request: ModelDownloadRequest) =>
    Effect.suspend(() => {
      if (active) return Effect.fail(fail("A voice model is already downloading."));
      const cancel = Deferred.makeUnsafe<void>();
      active = { cancel, progress: { bytesDone: 0, bytesTotal: request.expectedBytes } };
      return transfer(request).pipe(
        Effect.mapError((error) =>
          isModelDownloadError(error)
            ? error
            : fail("Could not save the voice model. Check free disk space and try again."),
        ),
        Effect.raceFirst(
          Deferred.await(cancel).pipe(Effect.andThen(Effect.fail(fail("Download cancelled.")))),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            active = null;
          }),
        ),
      );
    });

  return {
    download,
    /** Stops the running download and removes its partial file. False when none is running. */
    cancel: Effect.suspend(() =>
      active
        ? Deferred.succeed(active.cancel, undefined).pipe(Effect.as(true))
        : Effect.succeed(false),
    ),
    /** Progress of the running download, or null when none is. */
    progress: () => active?.progress ?? null,
  };
}
