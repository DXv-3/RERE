import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import { SESSION_FILTER_CHOICES } from "../lib/sessionFilter";
import * as MobilePreferences from "./mobile-preferences";
import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";

function preferenceStore(initial: Record<string, unknown>) {
  let stored: StoredPreferencesJson = { payload: JSON.stringify(initial), updatedAt: 1 };
  const database = MobileDatabase.of({
    loadCache: () => Effect.succeed(Option.none()),
    listCache: () => Effect.succeed([]),
    saveCache: () => Effect.void,
    removeCache: () => Effect.void,
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.sync(() => Option.some(stored)),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  return MobilePreferences.make().pipe(
    Effect.provideService(MobileDatabase, database),
    Effect.provideService(MobileSecureStorage, {
      getItem: () => Effect.succeed(null),
      setItem: () => Effect.void,
      removeItem: () => Effect.void,
    }),
  );
}

describe("persisted mobile session filter", () => {
  it.effect("round-trips every choice through a fresh store and retains other preferences", () =>
    Effect.gen(function* () {
      const make = preferenceStore({ threadListSettledShelfExpanded: true, baseFontSize: 17 });
      const first = yield* make;
      for (const { value } of SESSION_FILTER_CHOICES) {
        yield* first.savePatch({ sessionFilter: value });
        const reopened = yield* make;
        expect(yield* reopened.load).toEqual({
          sessionFilter: value,
          threadListSettledShelfExpanded: true,
          baseFontSize: 17,
        });
      }
    }),
  );

  it.effect("discards unknown stored filters without discarding other preferences", () =>
    Effect.gen(function* () {
      for (const sessionFilter of ["unknown", null, 42]) {
        const store = yield* preferenceStore({ sessionFilter, baseFontSize: 17 });
        expect(yield* store.load).toEqual({ baseFontSize: 17 });
      }
      const legacy = yield* preferenceStore({});
      expect(yield* legacy.load).toEqual({});
    }),
  );
});
