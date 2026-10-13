import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AccountEmails from "./AccountEmails.ts";

describe("AccountEmails", () => {
  it.effect("never fails the request it rides on when the database is away", () => {
    const store = AccountEmails.AccountEmailStore.of({
      upsertIfChanged: () =>
        Effect.fail(
          new AccountEmails.AccountEmailPersistenceError({
            operation: "upsert-if-changed",
            cause: new Error("database unavailable"),
          }),
        ),
      find: () => Effect.succeed(null),
      findFirstName: () => Effect.succeed(null),
    });
    return Effect.gen(function* () {
      const accounts = yield* AccountEmails.AccountEmails;
      yield* accounts.record({
        userId: "u",
        email: "a@example.com",
        emailVerified: true,
        firstName: "Sam",
      });
      expect(yield* accounts.lookup({ userId: "u" })).toBeNull();
    }).pipe(
      Effect.provide(
        AccountEmails.layerWithStore.pipe(
          Layer.provide(Layer.succeed(AccountEmails.AccountEmailStore, store)),
        ),
      ),
    );
  });
});
