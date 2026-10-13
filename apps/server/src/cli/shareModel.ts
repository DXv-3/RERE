/**
 * `t3 share-model` - give someone the models one provider serves on a running
 * server, without pairing them to it. Shares are written to the database the
 * live server reads, the way `t3 pair` mints its tokens.
 */
import { MODEL_SHARE_ROUTE_PREFIX, type ModelShare } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ModelShareInviteRelay from "../provider/ModelShareInviteRelay.ts";
import * as ModelShares from "../provider/ModelShares.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import { baseDirFlag } from "./config.ts";
import { discoverPairTarget, makePairServerConfig, resolveDirectPairingBaseUrl } from "./pair.ts";

const urlFlag = Flag.String("url").pipe(
  Flag.withDescription(
    "The address other people reach this server at, for example `https://code.example.com`.",
  ),
  Flag.optional,
);

/** What the recipient needs, in the words their provider settings use. */
function formatShareInstructions(input: {
  readonly share: ModelShare;
  readonly token: string;
  readonly serverUrl: string;
  readonly emailed?: boolean;
}): string {
  const baseUrl = `${input.serverUrl.replace(/\/+$/, "")}${MODEL_SHARE_ROUTE_PREFIX}`;
  return [
    `Model share created for ${input.share.label}. The token is shown only this once.`,
    ...(input.share.recipientEmail
      ? [
          "",
          input.emailed === true
            ? `Shared with ${input.share.recipientEmail}. We emailed them, and it appears in their CodeWrench when they sign in.`
            : `Shared with ${input.share.recipientEmail}. It appears in their CodeWrench when they sign in.`,
          "If you would rather send it by hand, use the details below.",
        ]
      : []),
    "",
    "They add a Claude provider in Settings > Providers with these environment variables:",
    `  ANTHROPIC_BASE_URL    ${baseUrl}`,
    `  ANTHROPIC_AUTH_TOKEN  ${input.token}`,
    `and these custom models: ${input.share.models.join(", ")}`,
    "",
    "They can use the model from their own machine. They cannot pair with this server,",
    "read its threads, or run anything on it.",
    "",
    `Take it back any time: t3 share-model revoke ${input.share.id}`,
    ...(isLoopbackHost(new URL(baseUrl).hostname)
      ? [
          "",
          "This address only works on this machine. Pass --url with the address other people reach this server at.",
        ]
      : []),
  ].join("\n");
}

function formatShareList(shares: ReadonlyArray<ModelShare>): string {
  if (shares.length === 0) return "No model shares.";
  return shares
    .map((share) =>
      [
        `${share.label}  (${share.id})`,
        `  provider ${share.providerInstanceId}, models ${share.models.join(", ")}`,
        `  created ${share.createdAt}, ${share.lastUsedAt ? `last used ${share.lastUsedAt}` : "never used"}`,
        ...(share.recipientEmail
          ? [
              `  shared with ${share.recipientEmail}, ${share.inviteAcceptedAt ? "in their CodeWrench" : "waiting for them to sign in"}`,
            ]
          : []),
      ].join("\n"),
    )
    .join("\n");
}

const withModelShares = <A, E>(
  baseDir: Option.Option<string>,
  use: (shares: ModelShares.ModelShares["Service"], serverUrl: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const cliLogLevel = yield* GlobalFlag.LogLevel;
    const target = yield* discoverPairTarget(Option.getOrUndefined(baseDir));
    const config = yield* makePairServerConfig({
      target,
      logLevel: Option.getOrElse(cliLogLevel, () => "Warn" as const),
    });
    return yield* Effect.gen(function* () {
      return yield* use(yield* ModelShares.ModelShares, resolveDirectPairingBaseUrl(target.state));
    }).pipe(
      Effect.provide(
        ModelShares.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(ModelShareInviteRelay.layer.pipe(Layer.provide(ServerSecretStore.layer))),
          Layer.provide(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
          Layer.provide(SqlitePersistence.layerConfig),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer));

const createCommand = Command.make("create", {
  baseDir: baseDirFlag,
  provider: Argument.String("provider").pipe(
    Argument.withDescription("Id of the provider to share, as listed in Settings > Providers."),
  ),
  label: Flag.String("label").pipe(Flag.withDescription("Who the share is for.")),
  model: Flag.String("model").pipe(
    Flag.withDescription("Share only this model. Repeat for several; defaults to all of them."),
    Flag.atLeast(0),
  ),
  email: Flag.String("email").pipe(
    Flag.withDescription(
      "Also offer the share to the CodeWrench account with this email. Needs this machine signed in.",
    ),
    Flag.optional,
  ),
  url: urlFlag,
}).pipe(
  Command.withDescription("Create a model share and print what to send its recipient."),
  Command.withHandler((flags) =>
    withModelShares(flags.baseDir, (shares, serverUrl) =>
      shares
        .create({
          label: flags.label,
          providerInstanceId: flags.provider,
          models: flags.model,
          ...(Option.isSome(flags.email) ? { recipientEmail: flags.email.value } : {}),
        })
        .pipe(
          Effect.flatMap(({ share, token, emailed }) =>
            Console.log(
              formatShareInstructions({
                share,
                token,
                serverUrl: Option.getOrElse(flags.url, () => serverUrl),
                ...(emailed === true ? { emailed } : {}),
              }),
            ),
          ),
        ),
    ),
  ),
);

const listCommand = Command.make("list", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("List model shares. Tokens are never shown again."),
  Command.withHandler((flags) =>
    withModelShares(flags.baseDir, (shares) =>
      shares.list.pipe(Effect.flatMap((list) => Console.log(formatShareList(list)))),
    ),
  ),
);

const revokeCommand = Command.make("revoke", {
  baseDir: baseDirFlag,
  id: Argument.String("id").pipe(Argument.withDescription("Share id from `share-model list`.")),
}).pipe(
  Command.withDescription("Revoke a model share. Its token stops working at once."),
  Command.withHandler((flags) =>
    withModelShares(flags.baseDir, (shares) =>
      shares
        .revoke(flags.id)
        .pipe(
          Effect.flatMap((revoked) =>
            Console.log(revoked ? "Share revoked." : "No share with that id."),
          ),
        ),
    ),
  ),
);

export const shareModelCommand = Command.make("share-model").pipe(
  Command.withDescription(
    "Let someone use a model this server serves, without giving them the server.",
  ),
  Command.withSubcommands([createCommand, listCommand, revokeCommand]),
);
