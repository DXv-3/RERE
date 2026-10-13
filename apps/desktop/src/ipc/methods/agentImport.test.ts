import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { pickAgentImportFile } from "./agentImport.ts";

const window = { webContents: { id: 7 } } as Electron.BrowserWindow;
const event = { sender: { id: 7 } };
const pickerLayer = (pickFiles: () => Effect.Effect<readonly string[]>) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(ElectronWindow.ElectronWindow)({ currentMainOrFirst: Effect.succeedSome(window) }),
    Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
  );

it.effect("returns only the chosen export and treats cancellation as no import", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-import-test-" });
    const file = path.join(dir, "bots.json");
    const text = '{"format":"fixture","agents":[]}';
    yield* fs.writeFileString(file, text);
    const choose = vi.fn(() => Effect.succeed([file]));
    const result = yield* pickAgentImportFile
      .handler(undefined, event)
      .pipe(Effect.provide(pickerLayer(choose)));
    assert.equal(result, text);
    assert.equal(choose.mock.calls.length, 1);
    const cancelled = yield* pickAgentImportFile
      .handler(undefined, event)
      .pipe(Effect.provide(pickerLayer(() => Effect.succeed([]))));
    assert.equal(cancelled, null);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects another renderer before opening a file chooser", () =>
  Effect.gen(function* () {
    const choose = vi.fn(() => Effect.succeed([]));
    const result = yield* pickAgentImportFile
      .handler(undefined, { sender: { id: 99 } })
      .pipe(Effect.provide(pickerLayer(choose)), Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(choose.mock.calls.length, 0);
  }),
);

it.effect("rejects oversized exports and directories without reading their contents", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "workbench-import-limit-" });
    const file = path.join(dir, "large.json");
    yield* fs.writeFile(file, new Uint8Array(10 * 1024 * 1024 + 1));
    for (const selected of [file, dir]) {
      const result = yield* pickAgentImportFile
        .handler(undefined, event)
        .pipe(Effect.provide(pickerLayer(() => Effect.succeed([selected]))), Effect.result);
      assert.equal(result._tag, "Failure");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
