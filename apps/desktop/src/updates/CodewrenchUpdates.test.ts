import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

// Import after setting the compiled constants, just as the packaged app does.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.effect(
  "pins CodeWrench updates, downloads automatically and never installs on quit or download",
  () =>
    Effect.gen(function* () {
      vi.stubGlobal("__WORKBENCH_PREVIEW__", true);
      vi.stubGlobal(
        "__CODEWRENCH_UPDATE_FEED_URL__",
        "https://updates.example.com/codewrench/mac/",
      );
      vi.resetModules();
      const { makeHarness, flushCallbacks } = yield* Effect.promise(
        () => import("./updatesTestHarness.ts"),
      );
      const { DesktopUpdates } = yield* Effect.promise(() => import("./DesktopUpdates.ts"));
      const harness = makeHarness({
        env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
        appUpdateYml: "provider: github\nowner: upstream\nrepo: t3code\n",
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates;
          yield* updates.configure;
          expect(harness.feedUrls()).toEqual([
            {
              provider: "generic",
              url: "https://updates.example.com/codewrench/mac/",
              channel: "latest",
            },
          ]);
          expect((yield* updates.getState).enabled).toBe(true);
          expect(harness.autoDownload()).toBe(true);
          expect(harness.autoInstallOnAppQuit()).toBe(false);
          expect(harness.allowDowngrade()).toBe(false);
          yield* updates.setChannel("nightly");
          expect(harness.updaterChannel()).toBe("latest");
          harness.emit("update-available", { version: "1.2.4-preview.20261008.61" });
          yield* flushCallbacks;
          harness.emit("update-downloaded", { version: "1.2.4-preview.20261008.61" });
          yield* flushCallbacks;
          expect((yield* updates.getState).status).toBe("downloaded");
          expect(harness.quitAndInstalls()).toBe(0);
          expect(harness.installSteps).toEqual([]);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
);
