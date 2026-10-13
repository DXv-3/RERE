import type { AccountAuthConfig, AccountTokens } from "@t3tools/shared/accountAuth";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  createAccountSessionCore,
  type AccountSessionCore,
} from "../account/AccountSessionCore.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __T3CODE_BUILD_OIDC_ISSUER__: string | undefined;
declare const __T3CODE_BUILD_OIDC_CLIENT_ID__: string | undefined;

function buildAccountConfig(): AccountAuthConfig | null {
  const issuer =
    typeof __T3CODE_BUILD_OIDC_ISSUER__ === "undefined" ? "" : __T3CODE_BUILD_OIDC_ISSUER__.trim();
  const clientId =
    typeof __T3CODE_BUILD_OIDC_CLIENT_ID__ === "undefined"
      ? ""
      : __T3CODE_BUILD_OIDC_CLIENT_ID__.trim();
  return issuer.startsWith("https://") && clientId ? { issuer, clientId } : null;
}

const StoredTokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  idToken: Schema.NullOr(Schema.String),
  expiresAtEpochMs: Schema.Number,
});
const StoredTokensJson = Schema.fromJsonString(StoredTokens);
const TokensDocumentJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), encryptedTokens: Schema.String }),
);
const decodeTokensDocument = Schema.decodeEffect(TokensDocumentJson);
const decodeStoredTokens = Schema.decodeEffect(StoredTokensJson);
const encodeTokensDocument = Schema.encodeEffect(TokensDocumentJson);
const encodeStoredTokens = Schema.encodeEffect(StoredTokensJson);

/** The signed-in account, held in the main process. Tokens never reach disk unencrypted. */
export class DesktopAccount extends Context.Service<
  DesktopAccount,
  { readonly session: AccountSessionCore }
>()("@t3tools/desktop/app/DesktopAccount") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const shell = yield* ElectronShell.ElectronShell;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const tokensPath = path.join(environment.stateDir, "account-tokens.json");

  const loadTokens = Effect.gen(function* () {
    if (!(yield* safeStorage.isEncryptionAvailable)) return null;
    const document = yield* decodeTokensDocument(yield* fileSystem.readFileString(tokensPath));
    const bytes = yield* Effect.fromResult(Encoding.decodeBase64(document.encryptedTokens));
    return yield* decodeStoredTokens(yield* safeStorage.decryptString(bytes));
  }).pipe(Effect.orElseSucceed((): AccountTokens | null => null));

  const saveTokens = (tokens: AccountTokens | null) =>
    Effect.gen(function* () {
      if (tokens === null) {
        yield* fileSystem.remove(tokensPath, { force: true });
        return;
      }
      // Without OS-level encryption the session lasts until the app quits.
      if (!(yield* safeStorage.isEncryptionAvailable)) return;
      const encryptedTokens = Encoding.encodeBase64(
        yield* safeStorage.encryptString(yield* encodeStoredTokens(tokens)),
      );
      const document = yield* encodeTokensDocument({
        version: 1,
        encryptedTokens,
      });
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      const tempPath = `${tokensPath}.${process.pid}.tmp`;
      yield* fileSystem.writeFileString(tempPath, `${document}\n`);
      yield* fileSystem.rename(tempPath, tokensPath);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the account session.", { error }),
      ),
    );

  const postForm = (url: string, body: URLSearchParams) =>
    runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const response = yield* httpClient.execute(
            HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(body)),
          );
          const json = yield* response.json.pipe(Effect.orElseSucceed((): unknown => null));
          return { status: response.status, body: json };
        }),
      ),
    );

  const revealMainWindow = electronWindow.currentMainOrFirst.pipe(
    Effect.flatMap((window) =>
      Option.isSome(window) ? electronWindow.reveal(window.value) : Effect.void,
    ),
  );

  const session = createAccountSessionCore({
    config: buildAccountConfig(),
    loadTokens: () => runPromise(loadTokens),
    saveTokens: (tokens) => runPromise(saveTokens(tokens)),
    postForm,
    now: () => runSync(Clock.currentTimeMillis),
    openExternal: (url) => runPromise(shell.openExternal(url)),
    onChange: (state) =>
      void runPromise(electronWindow.sendAll(IpcChannels.ACCOUNT_CHANGED_CHANNEL, state)),
    onSignedIn: () => void runPromise(revealMainWindow),
  });

  return DesktopAccount.of({ session });
});

export const layer = Layer.effect(DesktopAccount, make);
