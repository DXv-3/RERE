import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { makeTranscriptionQueue } from "./transcriptionQueue.ts";

/** Stands in for a transcription: announces it started, then waits until released or interrupted. */
const fakeWork = (name: string, log: string[]) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const work = Effect.gen(function* () {
      log.push(`${name} started`);
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      log.push(`${name} finished`);
      return name;
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push(`${name} killed`))));
    return { work, started, release };
  });

it.effect("a final transcription interrupts the running preview and then runs", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const queue = makeTranscriptionQueue();
    const preview = yield* fakeWork("preview", log);
    const previewFiber = yield* queue.run("preview", preview.work).pipe(Effect.forkChild);
    yield* Deferred.await(preview.started);

    const result = yield* queue.run(
      "final",
      Effect.sync(() => (log.push("final ran"), "text")),
    );

    expect(result).toBe("text");
    // The preview's cleanup (killing its child processes) completes before the final starts.
    expect(log).toEqual(["preview started", "preview killed", "final ran"]);
    const exit = yield* Fiber.await(previewFiber);
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      _tag: "DictationSupersededError",
    });
  }),
);

it.effect("two finals run one after the other and neither is refused", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const queue = makeTranscriptionQueue();
    const first = yield* fakeWork("first", log);
    const second = yield* fakeWork("second", log);
    const firstFiber = yield* queue.run("final", first.work).pipe(Effect.forkChild);
    yield* Deferred.await(first.started);
    const secondFiber = yield* queue.run("final", second.work).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(log).toEqual(["first started"]);

    yield* Deferred.succeed(first.release, undefined);
    yield* Deferred.await(second.started);
    yield* Deferred.succeed(second.release, undefined);

    expect(yield* Fiber.join(firstFiber)).toBe("first");
    expect(yield* Fiber.join(secondFiber)).toBe("second");
    expect(log).toEqual(["first started", "first finished", "second started", "second finished"]);
  }),
);

it.effect("a final does not interrupt another final", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const queue = makeTranscriptionQueue();
    const first = yield* fakeWork("first", log);
    const firstFiber = yield* queue.run("final", first.work).pipe(Effect.forkChild);
    yield* Deferred.await(first.started);
    const secondFiber = yield* queue.run("final", Effect.succeed("second")).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(first.release, undefined);
    expect(yield* Fiber.join(firstFiber)).toBe("first");
    expect(yield* Fiber.join(secondFiber)).toBe("second");
    expect(log).not.toContain("first killed");
  }),
);

it.effect("drops a preview that arrives while a final is running", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const queue = makeTranscriptionQueue();
    const final = yield* fakeWork("final", log);
    const finalFiber = yield* queue.run("final", final.work).pipe(Effect.forkChild);
    yield* Deferred.await(final.started);

    const dropped = yield* Effect.exit(
      queue.run(
        "preview",
        Effect.sync(() => log.push("preview ran")),
      ),
    );

    expect(Exit.isFailure(dropped)).toBe(true);
    yield* Deferred.succeed(final.release, undefined);
    yield* Fiber.join(finalFiber);
    expect(log).toEqual(["final started", "final finished"]);
  }),
);

it.effect("a newer preview replaces the one in flight", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const queue = makeTranscriptionQueue();
    const older = yield* fakeWork("older", log);
    const newer = yield* fakeWork("newer", log);
    const olderFiber = yield* queue.run("preview", older.work).pipe(Effect.forkChild);
    yield* Deferred.await(older.started);
    const newerFiber = yield* queue.run("preview", newer.work).pipe(Effect.forkChild);
    yield* Deferred.await(newer.started);
    yield* Deferred.succeed(newer.release, undefined);

    expect(yield* Fiber.join(newerFiber)).toBe("newer");
    expect(Exit.isFailure(yield* Fiber.await(olderFiber))).toBe(true);
    expect(log).toEqual(["older started", "older killed", "newer started", "newer finished"]);
  }),
);

it.effect("runs a preview normally when nothing else is transcribing", () =>
  Effect.gen(function* () {
    const queue = makeTranscriptionQueue();
    expect(yield* queue.run("preview", Effect.succeed("partial words"))).toBe("partial words");
    expect(yield* queue.run("final", Effect.succeed("all words"))).toBe("all words");
  }),
);
