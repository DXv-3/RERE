import { Deferred, Effect, Schema, Semaphore } from "effect";

/** A preview was dropped because newer audio or a final transcription took its place. */
export class DictationSupersededError extends Schema.TaggedError<DictationSupersededError>()(
  "DictationSupersededError",
  { message: Schema.String },
) {}

/**
 * Runs one transcription at a time. A final request is never refused: it cancels
 * the preview that is running (interrupting it, which kills its child processes)
 * and runs next, in order behind any other final. A preview is only a live
 * convenience, so a newer preview replaces an older one and a preview that
 * arrives while a final is queued or running is dropped.
 */
export function makeTranscriptionQueue() {
  const turn = Semaphore.makeUnsafe(1);
  let preview: Deferred.Deferred<void> | null = null;
  let finalsWaiting = 0;

  const superseded = (message: string) => new DictationSupersededError({ message });

  const runPreview = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      if (finalsWaiting > 0) return yield* superseded("A final transcription is waiting.");
      const cancelled = yield* Deferred.make<void>();
      const previous = preview;
      preview = cancelled;
      if (previous) yield* Deferred.succeed(previous, undefined);
      // Waiting for the turn is part of the race, so a replaced preview leaves the line too.
      return yield* turn
        .withPermits(1)(work)
        .pipe(
          Effect.raceFirst(
            Deferred.await(cancelled).pipe(
              Effect.andThen(Effect.fail(superseded("A newer preview replaced this one."))),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (preview === cancelled) preview = null;
            }),
          ),
        );
    });

  const runFinal = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      finalsWaiting++;
      const running = preview;
      if (running) yield* Deferred.succeed(running, undefined);
      return yield* turn.withPermits(1)(work);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalsWaiting--;
        }),
      ),
    );

  return {
    run: <A, E, R>(kind: "preview" | "final", work: Effect.Effect<A, E, R>) =>
      kind === "final" ? runFinal(work) : runPreview(work),
  };
}
