import {
  CampaignError,
  type CampaignConnectionSetInput,
  type CampaignConnectionState,
  type CampaignConnectionTestResult,
  type CampaignConnectorKind,
  type CampaignPost,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { makeExportConnector } from "./publishing/ExportConnector.ts";
import {
  makeMarketingEngineConnector,
  type EngineConfig,
} from "./publishing/MarketingEngineConnector.ts";
import type { PublishingConnector } from "./publishing/PublishingConnector.ts";

/** The marketing engine's key. Never in settings.json, never in a log, never sent to a client. */
export const CAMPAIGN_ENGINE_KEY_SECRET = "workbench-campaign-engine-key";
const KEY_MAX_LENGTH = 512;

const fail = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });

/** The engine's address as stored: a web address with no credentials and no trailing slash. */
export function normalizeEngineBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Which connector posts, and how it is reached: the base address lives in server settings, the
 * key in the server's secret store. Reads happen on every call, so a change takes effect on the
 * next post without a restart.
 */
export class CampaignConnection extends Context.Service<
  CampaignConnection,
  {
    readonly get: Effect.Effect<CampaignConnectionState, CampaignError>;
    readonly set: (
      input: CampaignConnectionSetInput,
    ) => Effect.Effect<CampaignConnectionState, CampaignError>;
    /** Tries the named connector, or the active one. */
    readonly test: (
      connector?: CampaignConnectorKind,
    ) => Effect.Effect<CampaignConnectionTestResult>;
    /** The connector selected in settings. */
    readonly active: Effect.Effect<PublishingConnector>;
    /** True only when the server setting `campaignPublishing` is "on". */
    readonly publishingOn: Effect.Effect<boolean>;
  }
>()("t3/campaigns/CampaignConnection") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsModule.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const exportServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | WorkspacePaths.WorkspacePaths
  >();

  const readSettings = settings.getSettings.pipe(
    Effect.mapError(() => fail("storage", "The server settings could not be read.")),
  );

  const readKey = secrets.get(CAMPAIGN_ENGINE_KEY_SECRET).pipe(
    Effect.map((value) => {
      if (Option.isNone(value)) return null;
      const key = new TextDecoder().decode(value.value).trim();
      return key === "" ? null : key;
    }),
    Effect.orElseSucceed(() => null),
  );

  const engineConfig: Effect.Effect<EngineConfig | null> = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const apiKey = yield* readKey;
    const baseUrl = current?.campaignEngineBaseUrl.trim() ?? "";
    return baseUrl === "" || apiKey === null ? null : { baseUrl, apiKey };
  });

  /** The folder an export goes to: the source thread's project folder, else the configured one. */
  const folderFor = (post: CampaignPost) =>
    Effect.gen(function* () {
      if (post.sourceThreadId !== undefined) {
        const shell = yield* threads.getThreadShell(post.sourceThreadId as ThreadId);
        if (shell !== null) {
          const project = yield* projects.getById(shell.projectId);
          if (Option.isSome(project)) return shell.worktreePath ?? project.value.workspaceRoot;
        }
      }
      const configured = (yield* settings.getSettings).campaignExportDirectory.trim();
      return configured === "" ? null : configured;
    }).pipe(Effect.orElseSucceed(() => null));

  const exportConnector = yield* makeExportConnector({ folderFor }).pipe(
    Effect.provideContext(exportServices),
  );
  const engineConnector = makeMarketingEngineConnector({ http, config: engineConfig });

  const connectorOf = (kind: CampaignConnectorKind): PublishingConnector =>
    kind === "marketing-engine" ? engineConnector : exportConnector;

  const get: CampaignConnection["Service"]["get"] = Effect.gen(function* () {
    const current = yield* readSettings;
    return {
      connector: current.campaignConnector,
      baseUrl: current.campaignEngineBaseUrl,
      hasKey: (yield* readKey) !== null,
      publishing: current.campaignPublishing,
      exportDirectory: current.campaignExportDirectory,
    } satisfies CampaignConnectionState;
  });

  const set: CampaignConnection["Service"]["set"] = (input) =>
    Effect.gen(function* () {
      const baseUrl =
        input.baseUrl === undefined ? undefined : normalizeEngineBaseUrl(input.baseUrl);
      if (baseUrl === null) {
        return yield* fail(
          "invalid",
          "The engine address must be a web address like https://engine.example.com, with no login or query.",
        );
      }
      if (input.apiKey !== undefined && input.apiKey !== null) {
        const key = Redacted.value(input.apiKey).trim();
        if (key === "" || key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
          return yield* fail("invalid", "The key is empty, has spaces in it, or is too long.");
        }
        yield* secrets
          .set(CAMPAIGN_ENGINE_KEY_SECRET, new TextEncoder().encode(key))
          .pipe(Effect.mapError(() => fail("storage", "The key could not be stored.")));
      } else if (input.apiKey === null) {
        yield* secrets
          .remove(CAMPAIGN_ENGINE_KEY_SECRET)
          .pipe(Effect.mapError(() => fail("storage", "The key could not be removed.")));
      }
      yield* settings
        .updateSettings({
          ...(input.connector === undefined ? {} : { campaignConnector: input.connector }),
          ...(baseUrl === undefined ? {} : { campaignEngineBaseUrl: baseUrl }),
          ...(input.exportDirectory === undefined
            ? {}
            : { campaignExportDirectory: input.exportDirectory.trim() }),
        })
        .pipe(Effect.mapError(() => fail("storage", "The settings could not be saved.")));
      return yield* get;
    });

  const test: CampaignConnection["Service"]["test"] = (kind) =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const connector = connectorOf(kind ?? current?.campaignConnector ?? "export");
      const result = yield* connector.test();
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    });

  const active: CampaignConnection["Service"]["active"] = settings.getSettings.pipe(
    Effect.map((current) => connectorOf(current.campaignConnector)),
    // An unreadable setting falls back to the export, which sends nothing anywhere.
    Effect.orElseSucceed(() => exportConnector),
  );

  const publishingOn: CampaignConnection["Service"]["publishingOn"] = settings.getSettings.pipe(
    Effect.map((current) => current.campaignPublishing === "on"),
    Effect.orElseSucceed(() => false),
  );

  return CampaignConnection.of({ get, set, test, active, publishingOn });
});

export const layer = Layer.effect(CampaignConnection, make);
