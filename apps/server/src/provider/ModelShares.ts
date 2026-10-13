import * as NodeCrypto from "node:crypto";

import type {
  ModelShare,
  ProviderInstanceConfig,
  ServerSettings,
  ShareableModelProvider,
} from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { claudeUsesCustomEndpoint } from "./ClaudeEndpointScope.ts";
import * as ModelShareInviteRelay from "./ModelShareInviteRelay.ts";

const TOKEN_PREFIX = "cwm_";
const CLAUDE_DRIVER = "claudeAgent";
// A share used all day should not write a row per request.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const API_KEY_HELPER_TTL_MS = 5 * 60_000;
// One address: no whitespace, one @, a dotted domain. The relay and the sign-in provider decide
// whether it is a real account.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Where a share's requests go, with the credentials this environment uses there. */
export interface ModelShareUpstream {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type ModelShareRefusal =
  | "unknown_provider"
  | "provider_disabled"
  | "not_a_claude_provider"
  | "provider_uses_anthropic"
  | "no_models"
  | "model_not_served";

const REFUSAL_MESSAGES: Record<ModelShareRefusal, string> = {
  unknown_provider: "No provider with that id exists on this environment.",
  provider_disabled: "That provider is turned off.",
  not_a_claude_provider: "Only a Claude provider pointed at your own model endpoint can be shared.",
  provider_uses_anthropic:
    "That provider signs in to Anthropic. A subscription cannot be shared; share a provider that uses your own endpoint (ANTHROPIC_BASE_URL).",
  no_models: "That provider lists no custom models to share.",
  model_not_served: "That provider does not list one of the requested models.",
};

export class ModelShareRefusedError extends Schema.TaggedError<ModelShareRefusedError>()(
  "ModelShareRefusedError",
  {
    reason: Schema.Literals([
      "unknown_provider",
      "provider_disabled",
      "not_a_claude_provider",
      "provider_uses_anthropic",
      "no_models",
      "model_not_served",
    ]),
  },
) {
  override get message(): string {
    return REFUSAL_MESSAGES[this.reason];
  }
}

export class ModelShareStorageError extends Schema.TaggedError<ModelShareStorageError>()(
  "ModelShareStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or write model shares.";
  }
}

export class ModelShareUpstreamUnavailableError extends Schema.TaggedError<ModelShareUpstreamUnavailableError>()(
  "ModelShareUpstreamUnavailableError",
  { providerInstanceId: Schema.String },
) {
  override get message(): string {
    return "The shared provider is no longer available on this environment.";
  }
}

/**
 * Lets the owner of an environment hand someone the models one provider
 * instance serves, and nothing else: the holder of a share token can send
 * model requests through this environment, but cannot pair with it, read its
 * threads, or run anything on it.
 */
export class ModelShares extends Context.Service<
  ModelShares,
  {
    readonly create: (input: {
      readonly label: string;
      readonly providerInstanceId: string;
      /** Defaults to every custom model the provider lists. */
      readonly models?: ReadonlyArray<string>;
      /**
       * Also offer the share to the CodeWrench account with this email, so it appears in their app
       * once they sign in. Fails, creating nothing, when this machine is not signed in.
       */
      readonly recipientEmail?: string;
    }) => Effect.Effect<
      {
        readonly share: ModelShare;
        readonly token: string;
        /** Present and true only when the relay emailed the recipient. */
        readonly emailed?: boolean;
      },
      | ModelShareRefusedError
      | ModelShareStorageError
      | ModelShareInviteRelay.ModelShareInviteFailedError
    >;
    /** Shares made for an email also say whether that person has collected them yet. */
    readonly list: Effect.Effect<ReadonlyArray<ModelShare>, ModelShareStorageError>;
    /** The providers `create` would accept, for a picker. */
    readonly shareableProviders: Effect.Effect<
      ReadonlyArray<ShareableModelProvider>,
      ModelShareStorageError
    >;
    readonly revoke: (id: string) => Effect.Effect<boolean, ModelShareStorageError>;
    /** The share a token belongs to, if it is still valid. Records the use. */
    readonly authorize: (
      token: string,
    ) => Effect.Effect<Option.Option<ModelShare>, ModelShareStorageError>;
    readonly resolveUpstream: (
      share: ModelShare,
    ) => Effect.Effect<ModelShareUpstream, ModelShareUpstreamUnavailableError>;
  }
>()("t3/provider/ModelShares") {}

interface ShareableProvider {
  readonly baseUrl: string;
  readonly models: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  readonly homePath: string;
}

function configRecord(instance: ProviderInstanceConfig): Record<string, unknown> {
  const config: unknown = instance.config;
  return typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
}

/**
 * What a provider instance would serve through a share, or why it cannot be
 * shared. Only a Claude instance on a non-Anthropic endpoint qualifies: its
 * credentials are the owner's own gateway key, not a personal subscription.
 */
function readShareableProvider(
  settings: Pick<ServerSettings, "providerInstances">,
  providerInstanceId: string,
): ShareableProvider | ModelShareRefusal {
  const instance = (
    settings.providerInstances as Readonly<Record<string, ProviderInstanceConfig | undefined>>
  )[providerInstanceId];
  if (!instance) return "unknown_provider";
  if (instance.driver !== CLAUDE_DRIVER) return "not_a_claude_provider";
  if (instance.enabled === false) return "provider_disabled";
  const environment = Object.fromEntries(
    (instance.environment ?? []).map((variable) => [variable.name, variable.value]),
  );
  if (!claudeUsesCustomEndpoint(environment)) return "provider_uses_anthropic";
  const config = configRecord(instance);
  const models = readCustomModelEntries(config.customModels).map((model) => model.slug);
  if (models.length === 0) return "no_models";
  return {
    baseUrl: (environment.ANTHROPIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    models,
    environment,
    homePath: typeof config.homePath === "string" ? config.homePath.trim() : "",
  };
}

function hashToken(token: string): string {
  return NodeCrypto.createHash("sha256").update(token).digest("hex");
}

function credentialHeaders(environment: Readonly<Record<string, string | undefined>>) {
  const authToken = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken) return { authorization: `Bearer ${authToken}` };
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { "x-api-key": apiKey };
  return null;
}

const ClaudeHomeSettings = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  apiKeyHelper: Schema.optionalKey(Schema.String),
});
const decodeClaudeHomeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeHomeSettings),
);
const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeModels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

interface ShareRow {
  readonly share_id: string;
  readonly label: string;
  readonly provider_instance_id: string;
  readonly models_json: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly recipient_email: string | null;
  readonly invite_id: string | null;
}

function toShare(row: ShareRow): ModelShare {
  return {
    id: row.share_id,
    label: row.label,
    providerInstanceId: row.provider_instance_id,
    models: Option.getOrElse(decodeModels(row.models_json), () => []),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.recipient_email === null
      ? {}
      : { recipientEmail: row.recipient_email, inviteAcceptedAt: null }),
  };
}

const storageFailure = (cause: unknown) => new ModelShareStorageError({ cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* ServerSettingsModule.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const inviteRelay = yield* ModelShareInviteRelay.ModelShareInviteRelay;
  const helperCache = yield* Ref.make<{
    readonly helper: string;
    readonly key: string;
    readonly expiresAtMs: number;
  } | null>(null);

  const create: ModelShares["Service"]["create"] = Effect.fn("ModelShares.create")(
    function* (input) {
      const settings = yield* settingsService.getSettings.pipe(Effect.mapError(storageFailure));
      const provider = readShareableProvider(settings, input.providerInstanceId);
      if (typeof provider === "string") {
        return yield* new ModelShareRefusedError({ reason: provider });
      }
      const models = input.models && input.models.length > 0 ? input.models : provider.models;
      if (models.some((model) => !provider.models.includes(model))) {
        return yield* new ModelShareRefusedError({ reason: "model_not_served" });
      }
      const recipientEmail = input.recipientEmail?.trim().toLowerCase();
      if (recipientEmail !== undefined && !EMAIL_PATTERN.test(recipientEmail)) {
        return yield* new ModelShareInviteRelay.ModelShareInviteFailedError({
          reason: "email_invalid",
        });
      }
      const token = `${TOKEN_PREFIX}${NodeCrypto.randomBytes(32).toString("base64url")}`;
      const shareId = NodeCrypto.randomUUID();
      // The relay is asked first, so a machine that is not signed in fails here with nothing
      // created. If saving the share then fails, the invitation is taken back.
      const invite =
        recipientEmail === undefined
          ? null
          : yield* inviteRelay.create({ shareId, recipientEmail, models, token });
      const inviteId = invite?.inviteId ?? null;
      const share: ModelShare = {
        id: shareId,
        label: input.label,
        providerInstanceId: input.providerInstanceId,
        models,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        lastUsedAt: null,
        ...(recipientEmail === undefined ? {} : { recipientEmail, inviteAcceptedAt: null }),
      };
      yield* sql`
        INSERT INTO workbench_model_shares
          (share_id, token_hash, label, provider_instance_id, models_json, created_at,
           recipient_email, invite_id)
        VALUES
          (${share.id}, ${hashToken(token)}, ${share.label}, ${share.providerInstanceId},
           ${encodeModels(share.models)}, ${share.createdAt}, ${recipientEmail ?? null},
           ${inviteId})
      `.pipe(
        Effect.mapError(storageFailure),
        Effect.tapError(() =>
          inviteId === null ? Effect.void : inviteRelay.revoke(inviteId).pipe(Effect.ignore),
        ),
      );
      return { share, token, ...(invite?.emailed === true ? { emailed: true } : {}) };
    },
  );

  const readRows = sql<ShareRow>`
    SELECT share_id, label, provider_instance_id, models_json, created_at, last_used_at,
           recipient_email, invite_id
    FROM workbench_model_shares
    ORDER BY created_at
  `.pipe(Effect.mapError(storageFailure));

  const list: ModelShares["Service"]["list"] = Effect.gen(function* () {
    const rows = yield* readRows;
    if (!rows.some((row) => row.invite_id !== null)) return rows.map(toShare);
    // Whether an invitation was collected lives on the relay. If it cannot be asked, the shares
    // still list; the invitation simply shows as waiting.
    const statuses = yield* inviteRelay.statuses.pipe(
      Effect.map((records) => new Map(records.map((record) => [record.inviteId, record]))),
      Effect.orElseSucceed(() => new Map<string, { readonly acceptedAt: string | null }>()),
    );
    return rows.map((row) => {
      const share = toShare(row);
      const status = row.invite_id === null ? undefined : statuses.get(row.invite_id);
      return status === undefined ? share : { ...share, inviteAcceptedAt: status.acceptedAt };
    });
  });

  const shareableProviders: ModelShares["Service"]["shareableProviders"] =
    settingsService.getSettings.pipe(
      Effect.map((settings) =>
        Object.entries(settings.providerInstances).flatMap(([providerInstanceId, instance]) => {
          const provider = readShareableProvider(settings, providerInstanceId);
          return typeof provider === "string"
            ? []
            : [
                {
                  providerInstanceId,
                  displayName: instance.displayName?.trim() || providerInstanceId,
                  models: provider.models,
                },
              ];
        }),
      ),
      Effect.mapError(storageFailure),
    );

  const revoke: ModelShares["Service"]["revoke"] = Effect.fn("ModelShares.revoke")(function* (id) {
    const rows = yield* sql<{ readonly invite_id: string | null }>`
      DELETE FROM workbench_model_shares WHERE share_id=${id} RETURNING invite_id
    `.pipe(Effect.mapError(storageFailure));
    const row = rows[0];
    if (!row) return false;
    // The token already stops working here. Taking back the invitation keeps it from being offered
    // to a signed-in recipient, but it is not worth failing the revoke over.
    if (row.invite_id !== null) {
      yield* inviteRelay.revoke(row.invite_id).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not take back a model share invitation", {
            inviteId: row.invite_id,
            reason: error.reason,
          }),
        ),
      );
    }
    return true;
  });

  const authorize: ModelShares["Service"]["authorize"] = Effect.fn("ModelShares.authorize")(
    function* (token) {
      if (!token.startsWith(TOKEN_PREFIX)) return Option.none();
      const rows = yield* sql<ShareRow>`
        SELECT share_id, label, provider_instance_id, models_json, created_at, last_used_at,
           recipient_email, invite_id
        FROM workbench_model_shares
        WHERE token_hash=${hashToken(token)}
      `.pipe(Effect.mapError(storageFailure));
      const row = rows[0];
      if (!row) return Option.none();
      const now = yield* DateTime.now;
      if (
        row.last_used_at === null ||
        DateTime.toEpochMillis(now) - Date.parse(row.last_used_at) >= LAST_USED_WRITE_INTERVAL_MS
      ) {
        // Bookkeeping only: a failed write must not turn a valid token away.
        yield* sql`
          UPDATE workbench_model_shares SET last_used_at=${DateTime.formatIso(now)}
          WHERE share_id=${row.share_id}
        `.pipe(Effect.ignore);
      }
      return Option.some(toShare(row));
    },
  );

  const runApiKeyHelper = Effect.fn("ModelShares.runApiKeyHelper")(function* (helper: string) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const cached = yield* Ref.get(helperCache);
    if (cached && cached.helper === helper && cached.expiresAtMs > nowMs) return cached.key;
    const result = yield* processRunner
      .run({ command: "sh", args: ["-c", helper], timeout: "10 seconds" })
      .pipe(Effect.option);
    const key = Option.isSome(result) && result.value.code === 0 ? result.value.stdout.trim() : "";
    if (key.length === 0) return null;
    yield* Ref.set(helperCache, { helper, key, expiresAtMs: nowMs + API_KEY_HELPER_TTL_MS });
    return key;
  });

  // The same places the Claude CLI reads its gateway credentials from: the
  // instance environment first, then the settings file in its config directory.
  const resolveCredentialHeaders = Effect.fn("ModelShares.resolveCredentialHeaders")(function* (
    provider: ShareableProvider,
  ) {
    const fromInstance = credentialHeaders(provider.environment);
    if (fromInstance) return fromInstance;
    const home =
      provider.homePath.length > 0
        ? path.resolve(expandHomePath(provider.homePath))
        : path.resolve(expandHomePath("~/.claude"));
    const homeSettings = yield* fileSystem.readFileString(path.join(home, "settings.json")).pipe(
      Effect.map(decodeClaudeHomeSettings),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(homeSettings)) return {};
    const fromHome = credentialHeaders(homeSettings.value.env ?? {});
    if (fromHome) return fromHome;
    const helper = homeSettings.value.apiKeyHelper?.trim();
    if (!helper) return {};
    const key = yield* runApiKeyHelper(helper);
    return key === null ? {} : { authorization: `Bearer ${key}`, "x-api-key": key };
  });

  const resolveUpstream: ModelShares["Service"]["resolveUpstream"] = Effect.fn(
    "ModelShares.resolveUpstream",
  )(function* (share) {
    const unavailable = new ModelShareUpstreamUnavailableError({
      providerInstanceId: share.providerInstanceId,
    });
    const settings = yield* settingsService.getSettings.pipe(Effect.mapError(() => unavailable));
    const provider = readShareableProvider(settings, share.providerInstanceId);
    if (typeof provider === "string") return yield* unavailable;
    return {
      baseUrl: provider.baseUrl,
      headers: yield* resolveCredentialHeaders(provider),
    };
  });

  return ModelShares.of({
    create,
    list,
    shareableProviders,
    revoke,
    authorize,
    resolveUpstream,
  });
});

export const layer = Layer.effect(ModelShares, make);
