import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class AgentImportError extends Schema.TaggedError<AgentImportError>()("AgentImportError", {
  message: Schema.String,
}) {}

/** Reads only the single export chosen by the user in the native dialog. */
export const pickAgentImportFile = DesktopIpc.makeIpcMethod({
  channel: Channels.PICK_AGENT_IMPORT_FILE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn(function* (_, event) {
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = yield* windows.currentMainOrFirst;
    if (!event || Option.isNone(window) || window.value.webContents.id !== event.sender.id) {
      return yield* new AgentImportError({
        message: "Open agent import in the main Workbench window.",
      });
    }
    const dialog = yield* ElectronDialog.ElectronDialog;
    const files = yield* dialog
      .pickFiles({
        owner: window,
        defaultPath: Option.none(),
        filters: [{ name: "Grok Bot Export", extensions: ["json"] }],
        multiple: false,
      })
      .pipe(
        Effect.mapError(
          () => new AgentImportError({ message: "Could not open the import chooser." }),
        ),
      );
    const file = files[0];
    if (!file) return null;
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const info = yield* fs.stat(file);
      if (info.type !== "File" || Number(info.size) > 10 * 1024 * 1024) {
        return yield* new AgentImportError({ message: "Choose an export smaller than 10 MB." });
      }
      const bytes = yield* fs.readFile(file);
      if (bytes.byteLength > 10 * 1024 * 1024) {
        return yield* new AgentImportError({ message: "Choose an export smaller than 10 MB." });
      }
      return new TextDecoder().decode(bytes);
    }).pipe(
      Effect.catchTag("PlatformError", () =>
        Effect.fail(
          new AgentImportError({
            message: "Could not read this export. Choose a readable JSON file.",
          }),
        ),
      ),
    );
  }),
});
