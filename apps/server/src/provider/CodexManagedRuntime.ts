import { resolveManagedCodexHomeLayout } from "./CodexManagedHome.ts";
import { CodexSettings, ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import { materializeCodexShadowHome } from "./Drivers/CodexHomeLayout.ts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
const decodeSettings = Schema.decodeSync(CodexSettings);
// Managed sign-in keeps tokens in T3's credential store and never writes native auth.json.
const TOKEN_FILE = ".codewrench-access-token";
// Codex asks for the token again this often, so a session that outlives one token carries on with
// the next. It stays well inside the minute before expiry in which the store renews a token.
const TOKEN_REREAD_MS = 15_000;

const quoteLaunchValues = (values: ReadonlyArray<string>) =>
  values.map((value) => `-c '${value}'`).join(" ");

/**
 * Codex reads the token by running a command, so it picks up a renewed token in the middle of a
 * session. A token handed over once in the environment expired under long runs and ended them with
 * "Provided authentication token is expired".
 */
const managedCodexLaunchArgs = (tokenFile: string, platform: NodeJS.Platform) => {
  const [command, args] =
    platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "type", tokenFile]]
      : ["/bin/cat", [tokenFile]];
  return quoteLaunchValues([
    'model_provider="openai_token_sharing"',
    'model_providers.openai_token_sharing.name="OpenAI Token Sharing"',
    'model_providers.openai_token_sharing.base_url="https://api.openai.com/v1"',
    'model_providers.openai_token_sharing.model_catalog_url="https://api.openai.com/v1/models"',
    "features.api_key_model_discovery=true",
    // Native collaboration inserts agent_message history items, which the subscription
    // Responses endpoint rejects. T3's delegate_task still provides child agents and
    // returns their results through ordinary tool messages.
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    // Model catalogs can select V2 even when both feature flags are false.
    // agents.enabled is the explicit override that also blocks catalog-selected agents.
    "agents.enabled=false",
    // A path with a quote in it cannot be written into a launch argument; such a home falls back
    // to the token in the environment.
    ...(tokenFile.includes("'")
      ? ['model_providers.openai_token_sharing.env_key="ACCESS_TOKEN"']
      : [
          `model_providers.openai_token_sharing.auth.command=${JSON.stringify(command)}`,
          `model_providers.openai_token_sharing.auth.args=${JSON.stringify(args)}`,
          "model_providers.openai_token_sharing.auth.timeout_ms=5000",
          `model_providers.openai_token_sharing.auth.refresh_interval_ms=${TOKEN_REREAD_MS}`,
        ]),
    'model_providers.openai_token_sharing.wire_api="responses"',
    "model_providers.openai_token_sharing.requires_openai_auth=false",
    "model_providers.openai_token_sharing.supports_websockets=false",
  ]);
};

export const makeCodexManagedRuntime = Effect.fn("makeCodexManagedRuntime")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly config: CodexSettings;
  /** True while the user's skills should stay out of the shadow home. */
  readonly hideSkillListing?: Effect.Effect<boolean>;
}) {
  const installation = yield* CodexInstallation.CodexInstallation;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const auth = yield* makeCodexChatGptAuth({
    instanceId: options.instanceId,
    defaultReturnUrl: new URL(
      "/welcome",
      config.devUrl ?? `http://localhost:${config.port}`,
    ).toString(),
  });
  const homeLayout = yield* resolveManagedCodexHomeLayout(
    config.stateDir,
    options.instanceId,
    options.config,
  );
  const homePath = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
  const tokenFile = path.join(homePath, TOKEN_FILE);
  const writtenToken = yield* Ref.make<string | null>(null);
  // Written beside a temporary name and moved into place, so Codex never reads half a token.
  const writeToken = (accessToken: string, always = false) =>
    Effect.gen(function* () {
      if (!always && (yield* Ref.get(writtenToken)) === accessToken) return;
      const temporary = `${tokenFile}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, accessToken, { mode: 0o600 });
      yield* fs.rename(temporary, tokenFile);
      yield* Ref.set(writtenToken, accessToken);
    });
  // Once a session has been given the file, keep it current for as long as this provider lives.
  // `auth.access` renews a token in its last minute; a sign-out leaves nothing to hand out.
  yield* Effect.gen(function* () {
    if ((yield* Ref.get(writtenToken)) === null) return;
    const credentials = yield* auth.access;
    yield* writeToken(credentials.accessToken);
  }).pipe(
    Effect.catchCause(() =>
      fs
        .remove(tokenFile, { force: true })
        .pipe(Effect.ignore, Effect.andThen(Ref.set(writtenToken, null))),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(TOKEN_REREAD_MS / 2))),
    Effect.forkScoped,
  );
  const resolve = Effect.gen(function* () {
    const executable = yield* installation.acquire().pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "install",
            detail: "Set up managed Codex before starting a session.",
          }),
      ),
    );
    const credentials = yield* auth.access;
    const hideSkills = yield* options.hideSkillListing ?? Effect.succeed(false);
    yield* materializeCodexShadowHome(homeLayout, { hideSkills }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: cause.message,
          }),
      ),
    );
    yield* fs.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the managed Codex runtime.",
          }),
      ),
    );
    // Always written here: preparing the home may have cleared it.
    yield* writeToken(credentials.accessToken, true).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "runtime",
            detail: "Could not prepare the managed Codex runtime.",
          }),
      ),
    );
    // Ambient CLI overrides cannot redirect a T3-owned token to a different provider.
    const environment: NodeJS.ProcessEnv = {
      ...options.environment,
      ACCESS_TOKEN: credentials.accessToken,
      CODEX_HOME: homePath,
    };
    delete environment.T3CODE_CODEX_LAUNCH_ARGS;
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    return {
      config: decodeSettings({
        enabled: options.enabled,
        setupMode: "managed",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: managedCodexLaunchArgs(tokenFile, platform),
      }),
      environment,
      revision: credentials.accessToken,
    } satisfies CodexEffectiveRuntime;
  });
  return { auth, resolve, installation, homePath, homeLayout };
});
