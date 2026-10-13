import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";

// Production bundles replace this global with a literal; exercise that same branch.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.effect("isolates preview state from ambient T3 homes and disables upstream updates", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__WORKBENCH_PREVIEW__", true);
    vi.resetModules();
    const config = yield* Effect.promise(() => import("./DesktopConfig.ts"));
    const desktop = yield* Effect.promise(() => import("./DesktopEnvironment.ts"));
    const environment = yield* desktop.DesktopEnvironment.pipe(
      Effect.provide(
        desktop
          .layer({
            dirname: "/preview/apps/desktop/dist-electron",
            homeDirectory: "/Users/test",
            platform: "darwin",
            processArch: "arm64",
            appVersion: "0.0.45-preview.20261003.1",
            appPath: "/Applications/Workbench Preview.app/Contents/Resources/app.asar",
            isPackaged: true,
            resourcesPath: "/Applications/Workbench Preview.app/Contents/Resources",
            runningUnderArm64Translation: false,
          })
          .pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                config.layerTest({
                  T3CODE_HOME: "/Users/test/.t3",
                  T3CODE_DISABLE_AUTO_UPDATE: "false",
                }),
              ),
            ),
          ),
      ),
    );
    expect(environment.stateDir).toBe("/Users/test/.workbench-preview/userdata");
    expect(environment.displayName).toBe("CodeWrench");
    expect(environment.backendCwd).toBe("/Users/test");
    expect(environment.appUserModelId).toBe("com.savagedigital.workbench.preview");
    const settings = yield* Effect.gen(function* () {
      return yield* config.DesktopConfig;
    }).pipe(Effect.provide(config.layerTest({ T3CODE_DISABLE_AUTO_UPDATE: "false" })));
    expect(settings.disableAutoUpdate).toBe(true);
  }),
);

it.effect("never reads or migrates an existing T3 browser profile", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__WORKBENCH_PREVIEW__", true);
    vi.resetModules();
    const { resolveUserDataPath } = yield* Effect.promise(() => import("./DesktopUserData.ts"));
    const exists = vi.fn(() => Effect.succeed(true));
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const path = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: false,
        platform,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ exists })),
        Effect.provide(NodeServices.layer),
      );
      expect(path).toBe("/profiles/workbench-preview");
    }
    expect(exists).not.toHaveBeenCalled();
  }),
);
