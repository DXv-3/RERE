import * as NodeCrypto from "node:crypto";
import {
  getCampaignModelCapability,
  campaignModelOptionsError,
} from "@t3tools/shared/campaignModelCapabilities";
import {
  CampaignError,
  type Campaign,
  type CampaignClient,
  type CampaignGenerationBoard,
  type CampaignGenerationJob,
  type CampaignGenerationKind,
  CampaignGenerationOptions,
  type CampaignGenerationSettings,
  type CampaignGenerationSettingsInput,
  type CampaignGenerationStartInput,
  type CampaignGeneratorKind,
  type CampaignGeneratorService,
  type CampaignPostCreatedBy,
  type ThreadId,
} from "@t3tools/contracts";
import {
  effectiveMode,
  isValidLocalGpuWindow,
  LOCAL_GPU_VIDEO_PRESETS,
  localGpuWaitExpired,
  localGpuWindowNote,
} from "@t3tools/shared/campaignRules";
import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { CAMPAIGN_ENGINE_KEY_SECRET, normalizeEngineBaseUrl } from "../CampaignConnection.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as CampaignThreadNotifier from "../CampaignThreadNotifier.ts";
import { exportSlug } from "../publishing/ExportConnector.ts";
import type {
  GenerationConnector,
  GenerationRequest,
  GenerationTestResult,
} from "./GenerationConnector.ts";
import { downloadResult, MAX_IMAGE_BYTES } from "./GenerationDownload.ts";
import * as GenerationStore from "./GenerationStore.ts";
import {
  makeLocalGpuConnector,
  LOCAL_GPU_DEFAULT_MODEL,
  LOCAL_GPU_DEFAULT_VIDEO_MODEL,
  NEEDS_FIRST_FRAME,
} from "./LocalGpuConnector.ts";
import { locateLocalGpuScript } from "./localGpuScript.ts";
import { makeLocalImageConnector } from "./LocalImageConnector.ts";
import { makeMarketingEngineGenerator } from "./MarketingEngineGenerator.ts";
import {
  DEFAULT_FAL_IMAGE_MODEL,
  DEFAULT_FAL_TEXT_VIDEO_MODEL,
  DEFAULT_FAL_VIDEO_MODEL,
  makeFalConnector,
} from "./FalConnector.ts";
import {
  DEFAULT_MUAPI_IMAGE_MODEL,
  DEFAULT_MUAPI_TEXT_VIDEO_MODEL,
  DEFAULT_MUAPI_VIDEO_MODEL,
  makeMuapiConnector,
} from "./MuapiConnector.ts";
import {
  DEFAULT_OPENROUTER_IMAGE_MODEL,
  DEFAULT_OPENROUTER_VIDEO_MODEL,
  makeOpenRouterConnector,
} from "./OpenRouterConnector.ts";

export const CAMPAIGN_OPENROUTER_KEY_SECRET = "workbench-campaign-openrouter-key";
export const CAMPAIGN_MUAPI_KEY_SECRET = "workbench-campaign-muapi-key";
export const CAMPAIGN_FAL_KEY_SECRET = "workbench-campaign-fal-key";
const KEY_MAX_LENGTH = 512;
const MODEL_PATTERN = /^[A-Za-z0-9._:/+-]{0,200}$/;
const BOARD_JOB_LIMIT = 50;
/** A job still running after this long is given up on; the provider may still bill for it. */
const MAX_RUNNING_MS = 60 * 60 * 1000;
const FIRST_FRAME_MAX_BYTES = 8 * 1024 * 1024;
/** The largest video the graphics card's script may hand back: a 5 second clip is a few megabytes. */
const MAX_LOCAL_VIDEO_BYTES = 200 * 1024 * 1024;
const START_INTERVAL = "5 seconds";
const POLL_INTERVAL = "10 seconds";
/** A graphics-card job that found no room is tried again this often. */
const BUSY_RETRY_MS = 3 * 60 * 1000;

const NO_GENERATOR = {
  image: "No image generator is set up. Choose one in Settings, Connections, Campaign Publishing.",
  video: "No video generator is set up. Choose one in Settings, Connections, Campaign Publishing.",
} as const;
export const INTERRUPTED_LOCAL_GPU =
  "Interrupted by a restart. Nothing was charged; start it again.";
export const GAVE_UP_WAITING =
  "It waited more than 24 hours for the graphics card and was given up. Nothing was charged; start it again.";
const INTERRUPTED_WHILE_WAITING =
  "Interrupted while the provider was working on it. It may have been charged: check the provider's usage, then start it again.";

/** Minutes after midnight on this server's own clock. */
const localMinuteOfDay = (ms: number): number => {
  const parts = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(ms), DateTime.zoneMakeLocal()),
  );
  return parts.hour * 60 + parts.minute;
};

const decodeGenerationOptions = Schema.decodeUnknownEffect(CampaignGenerationOptions);
const encodeFingerprintJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fail = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });

/**
 * What a model is known to accept. Only models whose limits were read from the provider are listed;
 * any other model is passed the options as given and the provider reports what it refuses.
 */
const MODEL_LIMITS: Readonly<
  Record<
    string,
    {
      readonly minSeconds: number;
      readonly maxSeconds: number;
      readonly resolutions: ReadonlyArray<string>;
      /** Absent means any shape is passed on. */
      readonly aspectRatios?: ReadonlyArray<string>;
    }
  >
> = {
  // OpenRouter's page for this model (checked 2026-10-06): 4 to 15 seconds, 480p or 720p.
  "bytedance/seedance-2.0-fast": { minSeconds: 4, maxSeconds: 15, resolutions: ["480p", "720p"] },
};

/** What each video preset of this computer's graphics card makes: whole seconds, one size class. */
const LOCAL_VIDEO_LIMITS: typeof MODEL_LIMITS = Object.fromEntries(
  LOCAL_GPU_VIDEO_PRESETS.map((preset) => [
    preset.id,
    { minSeconds: preset.minSeconds, maxSeconds: preset.maxSeconds, resolutions: ["480p"] },
  ]),
);

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const VIDEO_FILE = /\.mp4$/i;
const MIME_FOR: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** An absolute path, or one under the home folder; no control characters. */
const LOCAL_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])\P{Cc}*$/u;

const isRelativeInside = (value: string): boolean =>
  value.trim() !== "" &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.split(/[\\/]/).includes("..");

/** An absolute path with no control characters and no `..`; whether it is inside the folder is checked later. */
const isAbsoluteLocalPath = (value: string): boolean =>
  LOCAL_PATH.test(value) && !value.startsWith("~") && !value.split(/[\\/]/).includes("..");

/** Anything that starts like a web address ("https:", "http:", "data:", ...). */
const WEB_ADDRESS = /^[A-Za-z][A-Za-z0-9+.-]+:/;

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export interface StartGeneration extends CampaignGenerationStartInput {
  /** A person's own click, or an agent's tool call. */
  readonly actor: CampaignPostCreatedBy;
}

/**
 * Makes images and video for campaigns. A person's start goes straight in line; an agent's goes
 * in line unless the client's or campaign's mode is ask-first, when it waits for a person. Jobs
 * live in the database: a restart polls running jobs again and never submits one twice.
 */
export class GenerationService extends Context.Service<
  GenerationService,
  {
    readonly campaignBudget: GenerationStore.GenerationStore["Service"]["campaignBudget"];
    readonly reserveExternalExpense: (
      input: GenerationStore.ExternalExpenseInput,
    ) => Effect.Effect<GenerationStore.ExternalExpenseReservation, CampaignError>;
    readonly startJob: (
      input: StartGeneration,
    ) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    /** A person starts a job an agent asked for under ask-first. */
    readonly approveJob: (jobId: string) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    /** Attach a provider receipt to an uncertain submission; never submits a new request. */
    readonly reconcileJob: (input: {
      readonly jobId: string;
      readonly providerJobId: string;
    }) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    readonly cancelJob: (jobId: string) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    readonly getJob: (jobId: string) => Effect.Effect<CampaignGenerationJob, CampaignError>;
    readonly listJobs: (input: {
      readonly clientId?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<CampaignGenerationJob>, CampaignError>;
    readonly settings: Effect.Effect<CampaignGenerationSettings, CampaignError>;
    readonly setSettings: (
      input: CampaignGenerationSettingsInput,
    ) => Effect.Effect<CampaignGenerationSettings, CampaignError>;
    readonly test: (
      service: CampaignGeneratorService,
      action?: "download" | undefined,
      kind?: CampaignGenerationKind | undefined,
    ) => Effect.Effect<{
      readonly ok: boolean;
      readonly reason?: string;
      readonly notes?: string;
    }>;
    readonly board: (
      campaignId: string | undefined,
    ) => Effect.Effect<CampaignGenerationBoard, CampaignError>;
    /** One pass: starts queued jobs and polls running ones. Returns when both are done. */
    readonly tick: Effect.Effect<void>;
    /** Fails what a restart interrupted before the provider had it; running jobs with an id stay. */
    readonly recover: Effect.Effect<void>;
    /** Recovers what a restart interrupted, then runs the two loops. */
    readonly begin: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/campaigns/generation/GenerationService") {}

/** Test seams. `estimate` replaces the connectors' own estimate so spend arithmetic can be exercised. */
export interface GenerationServiceOptions {
  readonly estimate?: (
    request: GenerationRequest,
    service: CampaignGeneratorService,
  ) => { readonly usd: number | null; readonly note: string };
}

const make = (serviceOptions: GenerationServiceOptions) =>
  Effect.gen(function* () {
    const jobs = yield* GenerationStore.GenerationStore;
    const campaigns = yield* CampaignStore.CampaignStore;
    const settings = yield* ServerSettingsModule.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const http = yield* HttpClient.HttpClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const notifier = yield* CampaignThreadNotifier.CampaignThreadNotifier;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const runner = yield* ProcessRunner.ProcessRunner;
    // Checking the month's spend and adding a job to it happen as one step.
    const spendLock = yield* Semaphore.make(1);
    const startPass = yield* Semaphore.make(1);
    const pollPass = yield* Semaphore.make(1);
    const localPass = yield* Semaphore.make(1);

    const readSettings = settings.getSettings.pipe(
      Effect.mapError(() => fail("storage", "The server settings could not be read.")),
    );
    const now = Effect.map(Clock.currentTimeMillis, (ms) =>
      DateTime.formatIso(DateTime.makeUnsafe(ms)),
    );
    const readSecret = (name: string) =>
      secrets.get(name).pipe(
        Effect.map((value) => {
          if (Option.isNone(value)) return null;
          const key = new TextDecoder().decode(value.value).trim();
          return key === "" ? null : key;
        }),
        Effect.orElseSucceed(() => null),
      );

    const localGpuConfig = settings.getSettings.pipe(
      Effect.map((current) => ({
        python: current.campaignLocalGpuPython,
        model: current.campaignLocalGpuModel,
        videoModel: current.campaignLocalGpuVideoModel,
        modelsDir: current.campaignLocalGpuModelsDir,
        whenBusy: current.campaignLocalGpuWhenBusy,
      })),
      Effect.orElseSucceed(() => ({
        python: "",
        model: "",
        videoModel: "",
        modelsDir: "",
        whenBusy: "fallback" as const,
      })),
    );

    const connectors: Record<CampaignGeneratorService, GenerationConnector> = {
      "local-gpu": makeLocalGpuConnector({
        runner,
        fileSystem,
        path,
        homeDir: NodeOS.homedir(),
        config: localGpuConfig,
        script: locateLocalGpuScript(fileSystem, path),
        videoScript: locateLocalGpuScript(
          fileSystem,
          path,
          import.meta.dirname,
          "generate_video.py",
        ),
      }),
      openrouter: makeOpenRouterConnector({
        http,
        config: readSecret(CAMPAIGN_OPENROUTER_KEY_SECRET).pipe(
          Effect.map((apiKey) => (apiKey === null ? null : { apiKey })),
        ),
      }),
      muapi: makeMuapiConnector({
        http,
        config: readSecret(CAMPAIGN_MUAPI_KEY_SECRET).pipe(
          Effect.map((apiKey) => (apiKey === null ? null : { apiKey })),
        ),
      }),
      fal: makeFalConnector({
        http,
        config: readSecret(CAMPAIGN_FAL_KEY_SECRET).pipe(
          Effect.map((apiKey) => (apiKey === null ? null : { apiKey })),
        ),
      }),
      "marketing-engine": makeMarketingEngineGenerator({
        http,
        config: Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
          const apiKey = yield* readSecret(CAMPAIGN_ENGINE_KEY_SECRET);
          const baseUrl = current?.campaignEngineBaseUrl.trim() ?? "";
          return baseUrl === "" || apiKey === null ? null : { baseUrl, apiKey };
        }),
      }),
      local: makeLocalImageConnector({
        http,
        config: settings.getSettings.pipe(
          Effect.map((current) =>
            current.campaignLocalBaseUrl.trim() === ""
              ? null
              : { baseUrl: current.campaignLocalBaseUrl.trim(), model: current.campaignLocalModel },
          ),
          Effect.orElseSucceed(() => null),
        ),
      }),
    };

    const settingsView: GenerationService["Service"]["settings"] = Effect.gen(function* () {
      const current = yield* readSettings;
      return {
        imageGenerator: current.campaignImageGenerator,
        videoGenerator: current.campaignVideoGenerator,
        hasOpenRouterKey: (yield* readSecret(CAMPAIGN_OPENROUTER_KEY_SECRET)) !== null,
        hasMuapiKey: (yield* readSecret(CAMPAIGN_MUAPI_KEY_SECRET)) !== null,
        hasFalKey: (yield* readSecret(CAMPAIGN_FAL_KEY_SECRET)) !== null,
        localBaseUrl: current.campaignLocalBaseUrl,
        models: {
          image: current.campaignImageModel,
          video: current.campaignVideoModel,
          local: current.campaignLocalModel,
        },
        localGpu: {
          python: current.campaignLocalGpuPython,
          model: current.campaignLocalGpuModel,
          videoModel: current.campaignLocalGpuVideoModel,
          modelsDir: current.campaignLocalGpuModelsDir,
          whenBusy: current.campaignLocalGpuWhenBusy,
          windowStart: current.campaignLocalGpuWindowStart,
          windowEnd: current.campaignLocalGpuWindowEnd,
        },
      } satisfies CampaignGenerationSettings;
    });

    const setSettings: GenerationService["Service"]["setSettings"] = (input) =>
      Effect.gen(function* () {
        if (input.imageGenerator === "marketing-engine") {
          return yield* fail("invalid", "The marketing engine makes video, not images.");
        }
        if (input.videoGenerator === "local") {
          return yield* fail("invalid", "A local server makes images, not video.");
        }
        for (const [label, value, allowEmpty] of [
          ["Python path", input.localGpuPython, true],
          ["Models folder", input.localGpuModelsDir, true],
        ] as const) {
          const trimmed = value?.trim();
          if (
            trimmed !== undefined &&
            !(allowEmpty && trimmed === "") &&
            !LOCAL_PATH.test(trimmed)
          ) {
            return yield* fail(
              "invalid",
              `The ${label} must be a full path, like /home/you/venv/bin/python, with no odd characters.`,
            );
          }
        }
        if (input.localGpuWindowStart !== undefined || input.localGpuWindowEnd !== undefined) {
          const current = yield* readSettings;
          const start = (input.localGpuWindowStart ?? current.campaignLocalGpuWindowStart).trim();
          const end = (input.localGpuWindowEnd ?? current.campaignLocalGpuWindowEnd).trim();
          if (!isValidLocalGpuWindow(start, end)) {
            return yield* fail(
              "invalid",
              "Set both night window times as 24-hour clock times like 22:00 and 06:00, or leave both empty.",
            );
          }
        }
        const gpuModel = input.localGpuModel?.trim();
        if (
          gpuModel !== undefined &&
          gpuModel !== "" &&
          !MODEL_PATTERN.test(gpuModel) &&
          !LOCAL_PATH.test(gpuModel)
        ) {
          return yield* fail(
            "invalid",
            "The graphics card model must be one of the presets, or the full path of a model folder.",
          );
        }
        const gpuVideoModel = input.localGpuVideoModel?.trim();
        if (
          gpuVideoModel !== undefined &&
          gpuVideoModel !== "" &&
          !LOCAL_GPU_VIDEO_PRESETS.some((preset) => preset.id === gpuVideoModel)
        ) {
          return yield* fail(
            "invalid",
            `The graphics card video model must be one of: ${LOCAL_GPU_VIDEO_PRESETS.map((preset) => preset.id).join(", ")}.`,
          );
        }
        for (const model of [input.imageModel, input.videoModel, input.localModel]) {
          if (model !== undefined && !MODEL_PATTERN.test(model.trim())) {
            return yield* fail(
              "invalid",
              "A model name has characters it cannot have, or is too long.",
            );
          }
        }
        const localBaseUrl =
          input.localBaseUrl === undefined ? undefined : normalizeEngineBaseUrl(input.localBaseUrl);
        if (localBaseUrl === null) {
          return yield* fail(
            "invalid",
            "The local server address must be a web address like http://localhost:8080, with no login or query.",
          );
        }
        if (input.openRouterKey !== undefined && input.openRouterKey !== null) {
          const key = Redacted.value(input.openRouterKey).trim();
          if (key === "" || key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
            return yield* fail("invalid", "The key is empty, has spaces in it, or is too long.");
          }
          yield* secrets
            .set(CAMPAIGN_OPENROUTER_KEY_SECRET, new TextEncoder().encode(key))
            .pipe(Effect.mapError(() => fail("storage", "The key could not be stored.")));
        } else if (input.openRouterKey === null) {
          yield* secrets
            .remove(CAMPAIGN_OPENROUTER_KEY_SECRET)
            .pipe(Effect.mapError(() => fail("storage", "The key could not be removed.")));
        }
        if (input.muapiKey !== undefined && input.muapiKey !== null) {
          const key = Redacted.value(input.muapiKey).trim();
          if (key === "" || key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
            return yield* fail("invalid", "The key is empty, has spaces in it, or is too long.");
          }
          yield* secrets
            .set(CAMPAIGN_MUAPI_KEY_SECRET, new TextEncoder().encode(key))
            .pipe(Effect.mapError(() => fail("storage", "The key could not be stored.")));
        } else if (input.muapiKey === null) {
          yield* secrets
            .remove(CAMPAIGN_MUAPI_KEY_SECRET)
            .pipe(Effect.mapError(() => fail("storage", "The key could not be removed.")));
        }
        if (input.falKey !== undefined && input.falKey !== null) {
          const key = Redacted.value(input.falKey).trim();
          if (key === "" || key.length > KEY_MAX_LENGTH || /\s/.test(key)) {
            return yield* fail("invalid", "The key is empty, has spaces in it, or is too long.");
          }
          yield* secrets
            .set(CAMPAIGN_FAL_KEY_SECRET, new TextEncoder().encode(key))
            .pipe(Effect.mapError(() => fail("storage", "The key could not be stored.")));
        } else if (input.falKey === null) {
          yield* secrets
            .remove(CAMPAIGN_FAL_KEY_SECRET)
            .pipe(Effect.mapError(() => fail("storage", "The key could not be removed.")));
        }
        yield* settings
          .updateSettings({
            ...(input.imageGenerator === undefined
              ? {}
              : { campaignImageGenerator: input.imageGenerator }),
            ...(input.videoGenerator === undefined
              ? {}
              : { campaignVideoGenerator: input.videoGenerator }),
            ...(input.imageModel === undefined
              ? {}
              : { campaignImageModel: input.imageModel.trim() }),
            ...(input.videoModel === undefined
              ? {}
              : { campaignVideoModel: input.videoModel.trim() }),
            ...(input.localModel === undefined
              ? {}
              : { campaignLocalModel: input.localModel.trim() }),
            ...(localBaseUrl === undefined ? {} : { campaignLocalBaseUrl: localBaseUrl }),
            ...(input.localGpuPython === undefined
              ? {}
              : { campaignLocalGpuPython: input.localGpuPython.trim() }),
            ...(gpuModel === undefined ? {} : { campaignLocalGpuModel: gpuModel }),
            ...(gpuVideoModel === undefined ? {} : { campaignLocalGpuVideoModel: gpuVideoModel }),
            ...(input.localGpuModelsDir === undefined
              ? {}
              : { campaignLocalGpuModelsDir: input.localGpuModelsDir.trim() }),
            ...(input.localGpuWhenBusy === undefined
              ? {}
              : { campaignLocalGpuWhenBusy: input.localGpuWhenBusy }),
            ...(input.localGpuWindowStart === undefined
              ? {}
              : { campaignLocalGpuWindowStart: input.localGpuWindowStart.trim() }),
            ...(input.localGpuWindowEnd === undefined
              ? {}
              : { campaignLocalGpuWindowEnd: input.localGpuWindowEnd.trim() }),
          })
          .pipe(Effect.mapError(() => fail("storage", "The settings could not be saved.")));
        yield* campaigns.touch;
        return yield* settingsView;
      });

    const test: GenerationService["Service"]["test"] = (service, action, kind) => {
      const connector = connectors[service];
      const unsupported: GenerationTestResult = {
        ok: false,
        reason: "There is nothing to download for this generator.",
      };
      const run =
        action === "download"
          ? (connector.download?.(kind) ?? Effect.succeed(unsupported))
          : connector.test(kind);
      return run.pipe(
        Effect.map((result) =>
          result.ok
            ? { ok: true, ...(result.notes === undefined ? {} : { notes: result.notes }) }
            : {
                ok: false,
                reason: result.reason,
                ...(result.notes === undefined ? {} : { notes: result.notes }),
              },
        ),
      );
    };

    // Starting a job

    const generatorFor = (
      kind: CampaignGenerationKind,
      hasFirstFrame: boolean,
      override?: { connector?: CampaignGeneratorService | undefined; model?: string | undefined },
    ) =>
      Effect.gen(function* () {
        const current = yield* readSettings;
        const chosen: CampaignGeneratorKind =
          override?.connector ??
          (kind === "image" ? current.campaignImageGenerator : current.campaignVideoGenerator);
        if (chosen === "none") return yield* fail("unavailable", NO_GENERATOR[kind]);
        if (kind === "image" && chosen === "marketing-engine") {
          return yield* fail("invalid", "The marketing engine makes video, not images.");
        }
        if (kind === "video" && chosen === "local") {
          return yield* fail("invalid", "A local server makes images, not video.");
        }
        const configuredModel =
          override?.connector === undefined
            ? (kind === "image" ? current.campaignImageModel : current.campaignVideoModel).trim()
            : "";
        const model =
          override?.model?.trim() ??
          (chosen === "openrouter"
            ? kind === "image"
              ? configuredModel || DEFAULT_OPENROUTER_IMAGE_MODEL
              : configuredModel || DEFAULT_OPENROUTER_VIDEO_MODEL
            : chosen === "fal"
              ? kind === "image"
                ? configuredModel || DEFAULT_FAL_IMAGE_MODEL
                : configuredModel ||
                  (hasFirstFrame ? DEFAULT_FAL_VIDEO_MODEL : DEFAULT_FAL_TEXT_VIDEO_MODEL)
              : chosen === "muapi"
                ? kind === "image"
                  ? configuredModel || DEFAULT_MUAPI_IMAGE_MODEL
                  : configuredModel ||
                    (hasFirstFrame ? DEFAULT_MUAPI_VIDEO_MODEL : DEFAULT_MUAPI_TEXT_VIDEO_MODEL)
                : chosen === "local-gpu"
                  ? kind === "video"
                    ? current.campaignLocalGpuVideoModel.trim() || LOCAL_GPU_DEFAULT_VIDEO_MODEL
                    : current.campaignLocalGpuModel.trim() || LOCAL_GPU_DEFAULT_MODEL
                  : chosen === "local"
                    ? current.campaignLocalModel.trim()
                    : "marketing-engine");
        if (model === "") {
          return yield* fail("invalid", "Set the local server's model name in Settings first.");
        }
        if (!MODEL_PATTERN.test(model) && !(chosen === "local-gpu" && LOCAL_PATH.test(model)))
          return yield* fail("invalid", "The model name is invalid.");
        return { service: chosen, model } as const;
      });

    /** Fills in what the person left out and checks what the model is known to accept. */
    const normalizeOptions = (
      kind: CampaignGenerationKind,
      model: string,
      options: CampaignGenerationOptions,
      service: CampaignGeneratorService,
    ) =>
      Effect.gen(function* () {
        if (service === "fal" || service === "muapi") {
          const capability = getCampaignModelCapability(service, model);
          if (capability === undefined)
            return yield* fail(
              "invalid",
              `${model} is not a supported ${service} model. Choose a verified model.`,
            );
          const normalized: CampaignGenerationOptions = {
            ...options,
            ...(options.aspectRatio === undefined && capability.defaultAspectRatio !== undefined
              ? { aspectRatio: capability.defaultAspectRatio }
              : {}),
            ...(options.durationSeconds === undefined && capability.defaultDuration !== undefined
              ? { durationSeconds: capability.defaultDuration }
              : {}),
            ...(options.resolution === undefined && capability.defaultResolution !== undefined
              ? { resolution: capability.defaultResolution }
              : {}),
            ...(options.generateAudio === undefined && capability.audio === "toggle"
              ? { generateAudio: false }
              : {}),
          };
          const error = campaignModelOptionsError(capability, kind, normalized);
          if (error !== null) return yield* fail("invalid", error);
          const frame = normalized.firstFrame;
          if (frame !== undefined && !isHttpsUrl(frame) && !isRelativeInside(frame))
            return yield* fail(
              "invalid",
              "The first frame must be an https link or an image file inside the thread's folder.",
            );
          return normalized;
        }
        if (kind === "image") {
          if (
            options.durationSeconds !== undefined ||
            options.firstFrame !== undefined ||
            options.firstFrameJobId !== undefined
          ) {
            return yield* fail("invalid", "Duration and first frame are for video only.");
          }
          return {
            aspectRatio: options.aspectRatio ?? "1:1",
            ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
          } satisfies CampaignGenerationOptions;
        }
        const onThisComputer = service === "local-gpu";
        const limits = onThisComputer ? LOCAL_VIDEO_LIMITS[model] : MODEL_LIMITS[model];
        const durationSeconds = options.durationSeconds ?? 5;
        const resolution = options.resolution ?? (onThisComputer ? "480p" : "720p");
        if (limits !== undefined) {
          if (durationSeconds < limits.minSeconds || durationSeconds > limits.maxSeconds) {
            return yield* fail(
              "invalid",
              `${model} makes ${limits.minSeconds} to ${limits.maxSeconds} second videos.`,
            );
          }
          if (!limits.resolutions.includes(resolution)) {
            return yield* fail("invalid", `${model} offers ${limits.resolutions.join(" or ")}.`);
          }
          const shape = options.aspectRatio ?? "16:9";
          if (limits.aspectRatios !== undefined && !limits.aspectRatios.includes(shape)) {
            return yield* fail("invalid", `${model} offers ${limits.aspectRatios.join(" or ")}.`);
          }
        }
        const frame = options.firstFrame?.trim();
        const hasFrame = frame !== undefined && frame !== "";
        if (onThisComputer) {
          // A web address is never fetched for this generator: the still must be a file on this computer.
          if (!hasFrame) return yield* fail("invalid", NEEDS_FIRST_FRAME);
          if (
            WEB_ADDRESS.test(frame) ||
            frame.startsWith("~") ||
            (!isRelativeInside(frame) && !isAbsoluteLocalPath(frame))
          ) {
            return yield* fail(
              "invalid",
              "The first frame must be an image file inside the thread's folder. A web address cannot be used with this computer's graphics card.",
            );
          }
        } else if (hasFrame && !isHttpsUrl(frame) && !isRelativeInside(frame)) {
          return yield* fail(
            "invalid",
            "The first frame must be an https link or an image file inside the thread's folder.",
          );
        }
        return {
          // This computer's video follows the shape of the still unless a shape is asked for.
          ...(options.aspectRatio === undefined && onThisComputer
            ? {}
            : { aspectRatio: options.aspectRatio ?? "16:9" }),
          durationSeconds,
          resolution,
          generateAudio: options.generateAudio ?? false,
          ...(hasFrame ? { firstFrame: frame } : {}),
        } satisfies CampaignGenerationOptions;
      });

    const contextOf = (clientId: string, campaignId: string | undefined) =>
      Effect.gen(function* () {
        const client = yield* campaigns.getClient(clientId);
        const campaign =
          campaignId === undefined ? undefined : yield* campaigns.getCampaign(campaignId);
        if (campaign !== undefined && campaign.clientId !== client.id) {
          return yield* fail("invalid", "That campaign belongs to a different client.");
        }
        return { client, campaign } as const;
      });

    const runQueued: Effect.Effect<void> = Effect.suspend(() =>
      Effect.all([queuedPass, localQueuedPass], { concurrency: 2, discard: true }),
    );

    /**
     * Swaps `firstFrameJobId` for the path of that job's picture. Only a finished image job of the
     * same client counts, and its file must sit in the same project folder the new job saves into.
     */
    const withFirstFrameFromJob = (
      client: CampaignClient,
      sourceThreadId: string | undefined,
      options: CampaignGenerationOptions,
    ) =>
      Effect.gen(function* () {
        const { firstFrameJobId, ...rest } = options;
        if (firstFrameJobId === undefined) return rest;
        if (rest.firstFrame !== undefined && rest.firstFrame.trim() !== "") {
          return yield* fail("invalid", "Name a first frame file or an earlier image, not both.");
        }
        const earlier = (yield* jobs.get(firstFrameJobId)).job;
        const picture = earlier.resultPaths[0];
        if (
          earlier.kind !== "image" ||
          earlier.status !== "done" ||
          earlier.clientId !== client.id ||
          picture === undefined ||
          !IMAGE_FILE.test(picture)
        ) {
          return yield* fail(
            "invalid",
            "A video can only start from a finished picture made for the same client.",
          );
        }
        const [there, here] = yield* Effect.all([
          rootForThread(earlier.sourceThreadId),
          rootForThread(sourceThreadId),
        ]);
        if (there !== here) {
          return yield* fail(
            "invalid",
            "That picture was saved in a different project folder from this video's thread.",
          );
        }
        return { ...rest, firstFrame: picture } satisfies CampaignGenerationOptions;
      });

    const startJob: GenerationService["Service"]["startJob"] = (input) =>
      spendLock
        .withPermit(
          Effect.gen(function* () {
            yield* decodeGenerationOptions(input.options).pipe(
              Effect.mapError(() => fail("invalid", "The generation options are invalid.")),
            );
            if (
              input.allowanceUsd !== undefined &&
              (!Number.isFinite(input.allowanceUsd) || input.allowanceUsd <= 0)
            )
              return yield* fail(
                "invalid",
                "The unknown-cost allowance must be a positive dollar amount.",
              );
            if (
              input.requestKey !== undefined &&
              (!input.requestKey.trim() || input.requestKey.length > 200)
            )
              return yield* fail("invalid", "The request key must contain 1 to 200 characters.");
            // Hash the request before consulting mutable defaults. Retries return the original snapshot.
            const requestFingerprint = NodeCrypto.createHash("sha256")
              .update(
                encodeFingerprintJson({
                  clientId: input.clientId,
                  campaignId: input.campaignId,
                  kind: input.kind,
                  connector: input.connector,
                  model: input.model,
                  prompt: input.prompt,
                  options: Object.fromEntries(
                    Object.entries(input.options).sort(([a], [b]) => a.localeCompare(b)),
                  ),
                  sourceThreadId: input.sourceThreadId,
                  actor: input.actor,
                  forceApproval: input.forceApproval,
                  allowanceUsd: input.allowanceUsd,
                }),
              )
              .digest("hex");
            if (input.requestKey !== undefined) {
              const earlier = yield* jobs.findRequest(input.requestKey);
              if (earlier !== undefined) {
                if (earlier.requestFingerprint !== requestFingerprint)
                  return yield* fail(
                    "conflict",
                    "This request key already belongs to a different generation request.",
                  );
                return earlier.job;
              }
            }
            if (input.prompt.trim() === "") return yield* fail("invalid", "Write what to make.");
            const { client, campaign } = yield* contextOf(input.clientId, input.campaignId);
            const { service, model } = yield* generatorFor(
              input.kind,
              (input.options.firstFrame?.trim() ?? "") !== "" ||
                input.options.firstFrameJobId !== undefined,
              input,
            );
            const sourceThreadId =
              input.actor.kind === "agent" ? input.actor.threadId : input.sourceThreadId;
            const named =
              input.kind !== "video" || input.options.firstFrameJobId === undefined
                ? input.options
                : yield* withFirstFrameFromJob(client, sourceThreadId, input.options);
            const options = yield* normalizeOptions(input.kind, model, named, service);
            const capability = getCampaignModelCapability(service, model);
            if (input.prompt.length > (capability?.maxPromptLength ?? 4000))
              return yield* fail("invalid", "The prompt is too long for this model.");
            const estimateRequest = {
              kind: input.kind,
              model,
              prompt: input.prompt,
              options,
              name: "",
            } satisfies GenerationRequest;
            const estimate =
              serviceOptions.estimate?.(estimateRequest, service) ??
              connectors[service].estimate(estimateRequest);
            const reservedUsd = estimate.usd ?? input.allowanceUsd;
            if (reservedUsd === undefined)
              return yield* fail(
                "not_allowed",
                "This model has unknown pricing. Set an explicit dollar allowance and approve it before generation.",
              );
            if (!Number.isFinite(reservedUsd) || reservedUsd < 0)
              return yield* fail("invalid", "The generation estimate is invalid.");
            const waits =
              input.forceApproval === true ||
              (input.actor.kind === "agent" && effectiveModeOf(client, campaign) === "ask-first");
            return yield* jobs.create({
              clientId: client.id,
              campaignId: campaign?.id,
              kind: input.kind,
              connector: service,
              model,
              prompt: input.prompt.trim(),
              options,
              status: waits ? "needs-approval" : "queued",
              estimatedUsd: estimate.usd,
              estimateNote:
                estimate.usd === null
                  ? `${estimate.note} $${reservedUsd.toFixed(2)} reserved as an allowance, not a provider quote or billing ceiling.`
                  : estimate.note,
              reservedUsd,
              allowanceUsd: estimate.usd === null ? input.allowanceUsd : undefined,
              requestKey: input.requestKey,
              requestFingerprint,
              requestedBy: input.actor,
              sourceThreadId,
            });
          }),
        )
        .pipe(
          Effect.tap((job) =>
            job.status === "queued" ? Effect.forkDetach(runQueued) : Effect.void,
          ),
        );

    const effectiveModeOf = (client: CampaignClient, campaign: Campaign | undefined) =>
      campaign === undefined ? client.approvalMode : effectiveMode(client, campaign);

    const approveJob: GenerationService["Service"]["approveJob"] = (jobId) =>
      spendLock
        .withPermit(
          Effect.gen(function* () {
            const stored = yield* jobs.get(jobId);
            if (stored.job.status !== "needs-approval") {
              return yield* fail("conflict", "This job is not waiting for approval.");
            }
            if (!(yield* jobs.approve(jobId))) {
              return yield* fail("conflict", "This job is not waiting for approval.");
            }
            return (yield* jobs.get(jobId)).job;
          }),
        )
        .pipe(Effect.tap(() => Effect.forkDetach(runQueued)));

    const reconcileJob: GenerationService["Service"]["reconcileJob"] = (input) =>
      spendLock.withPermit(
        Effect.gen(function* () {
          const stored = yield* jobs.get(input.jobId);
          if (
            stored.job.status !== "running" ||
            stored.job.submissionState !== "uncertain" ||
            stored.providerJobId !== null
          )
            return yield* fail(
              "conflict",
              "Only an uncertain submission without a receipt can be reconciled.",
            );
          let valid = false;
          if (stored.job.connector === "muapi")
            valid = /^[A-Za-z0-9_-]{1,200}$/.test(input.providerJobId);
          if (stored.job.connector === "fal") {
            try {
              const url = new URL(input.providerJobId);
              valid =
                url.protocol === "https:" &&
                url.hostname === "queue.fal.run" &&
                url.port === "" &&
                url.username === "" &&
                url.password === "" &&
                url.search === "" &&
                url.hash === "" &&
                /\/requests\/[^/]+$/.test(url.pathname);
            } catch {
              valid = false;
            }
          }
          if (!valid)
            return yield* fail("invalid", "Use the receipt from this job's provider dashboard.");
          yield* jobs.setProviderJobId(input.jobId, input.providerJobId);
          return (yield* jobs.get(input.jobId)).job;
        }),
      );

    const cancelJob: GenerationService["Service"]["cancelJob"] = (jobId) =>
      Effect.gen(function* () {
        const before = yield* jobs.get(jobId);
        if (!(yield* jobs.cancel(jobId))) {
          return yield* fail("conflict", `This job is already ${before.job.status}.`);
        }
        return (yield* jobs.get(jobId)).job;
      });

    // Saving a result

    /** The folder results go into: the source thread's project folder, else the export folder. */
    const rootForThread = (threadId: string | undefined) =>
      Effect.gen(function* () {
        if (threadId !== undefined) {
          const shell = yield* threads.getThreadShell(threadId as ThreadId);
          if (shell !== null) {
            const project = yield* projects.getById(shell.projectId);
            if (Option.isSome(project)) return shell.worktreePath ?? project.value.workspaceRoot;
          }
        }
        const configured = (yield* settings.getSettings).campaignExportDirectory.trim();
        return configured === "" ? null : configured;
      }).pipe(Effect.orElseSucceed(() => null));

    const rootFor = (job: CampaignGenerationJob) => rootForThread(job.sourceThreadId);

    const NO_FOLDER =
      "There is no project folder to save into. Start it from a thread, or set an export folder in Settings.";

    const openRoot = (root: string) =>
      Effect.gen(function* () {
        const normalized = yield* workspacePaths
          .normalizeWorkspaceRoot(root)
          .pipe(Effect.mapError(() => "The project folder is not available."));
        const realRoot = yield* fileSystem
          .realPath(normalized)
          .pipe(Effect.mapError(() => "The project folder is not available."));
        return { root: normalized, realRoot };
      });

    /**
     * Moves an image or video the connector made on this computer into the results folder. Only a plain
     * image or video file that really sits inside the job's own work folder is accepted.
     */
    const moveLocalFile = (
      workDir: string,
      file: string,
      basePath: string,
      kind: CampaignGenerationKind,
    ) =>
      Effect.gen(function* () {
        const [realWork, real] = yield* Effect.all([
          fileSystem.realPath(workDir),
          fileSystem.realPath(file),
        ]).pipe(Effect.mapError(() => `The ${kind} file was not found.`));
        const inside = path.relative(realWork, real);
        if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
          return yield* Effect.fail(`The ${kind} file is outside its work folder.`);
        }
        const extension = path.extname(real).slice(1).toLowerCase();
        if (!(kind === "video" ? VIDEO_FILE : IMAGE_FILE).test(real) || extension === "") {
          return yield* Effect.fail(
            `The result is not a${kind === "video" ? " video" : "n image"} file.`,
          );
        }
        const info = yield* fileSystem
          .stat(real)
          .pipe(Effect.mapError(() => `The ${kind} file could not be read.`));
        if (
          info.type !== "File" ||
          Number(info.size) === 0 ||
          Number(info.size) > (kind === "video" ? MAX_LOCAL_VIDEO_BYTES : MAX_IMAGE_BYTES)
        ) {
          return yield* Effect.fail(`The ${kind} file was empty or too large to save.`);
        }
        const part = `${basePath}.${extension}.part`;
        yield* fileSystem.copyFile(real, part).pipe(
          Effect.flatMap(() => fileSystem.rename(part, `${basePath}.${extension}`)),
          Effect.tapError(() => fileSystem.remove(part, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(() => "The image could not be saved."),
        );
        return { extension };
      });

    const saveResults = (
      job: CampaignGenerationJob,
      urls: ReadonlyArray<string>,
      local: { readonly workDir: string; readonly files: ReadonlyArray<string> } | undefined,
    ) =>
      Effect.gen(function* () {
        const root = yield* rootFor(job);
        if (root === null) return yield* Effect.fail(NO_FOLDER);
        const { root: normalized, realRoot } = yield* openRoot(root);
        const client = yield* campaigns
          .getClient(job.clientId)
          .pipe(Effect.mapError(() => "The client is gone."));
        const campaign =
          job.campaignId === undefined
            ? undefined
            : yield* campaigns
                .getCampaign(job.campaignId)
                .pipe(Effect.option, Effect.map(Option.getOrUndefined));
        const relativeDir = `campaigns/${exportSlug(client.name)}/${campaign === undefined ? "unsorted" : exportSlug(campaign.name)}/generated`;
        const target = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot: normalized, relativePath: relativeDir })
          .pipe(Effect.mapError(() => "The folder for results is outside the project."));
        yield* fileSystem
          .makeDirectory(target.absolutePath, { recursive: true })
          .pipe(Effect.mapError(() => "Could not create the folder for results."));
        // A symlinked `campaigns` folder must not lead the file out of the project.
        const realOut = yield* fileSystem
          .realPath(target.absolutePath)
          .pipe(Effect.mapError(() => "Could not create the folder for results."));
        const outRelative = path.relative(realRoot, realOut);
        if (outRelative.startsWith("..") || path.isAbsolute(outRelative)) {
          return yield* Effect.fail("The folder for results is outside the project.");
        }
        const saved: string[] = [];
        for (const [index, url] of urls.entries()) {
          const base = `${job.id}${index === 0 ? "" : `-${index + 1}`}`;
          const done = yield* downloadResult({ http, fileSystem }, url, path.join(realOut, base));
          saved.push(`${relativeDir}/${base}.${done.extension}`);
        }
        for (const [index, file] of (local?.files ?? []).entries()) {
          const base = `${job.id}${urls.length + index === 0 ? "" : `-${urls.length + index + 1}`}`;
          const done = yield* moveLocalFile(
            local?.workDir ?? "",
            file,
            path.join(realOut, base),
            job.kind,
          );
          saved.push(`${relativeDir}/${base}.${done.extension}`);
        }
        return saved;
      });

    const tellAgent = (job: CampaignGenerationJob) =>
      job.requestedBy.kind === "agent" && job.sourceThreadId !== undefined
        ? notifier.tell({
            threadId: job.sourceThreadId as ThreadId,
            key: `generation:${job.id}:${job.status}`,
            text:
              job.status === "done"
                ? `Your ${job.kind} generation ${job.id} finished and was saved to:\n\n${job.resultPaths.join("\n")}\n\nLook at it with media_inspect. If it is right, attach it to a post with campaign_post_save (mediaPaths).`
                : `Your ${job.kind} generation ${job.id} ${job.status === "cancelled" ? "was cancelled by a person" : "failed"}${job.error === undefined ? "." : `: ${job.error}`}\n\nDo not start it again in a loop. Tell the person what happened and ask what they want.`,
          })
        : Effect.void;

    const settle = (
      id: string,
      outcome:
        | { readonly status: "done"; readonly resultPaths: ReadonlyArray<string> }
        | { readonly status: "failed"; readonly error: string },
    ) =>
      Effect.gen(function* () {
        if (!(yield* jobs.finish(id, outcome))) return;
        yield* tellAgent((yield* jobs.get(id)).job);
      });

    const complete = (
      job: CampaignGenerationJob,
      urls: ReadonlyArray<string>,
      local?: { readonly workDir: string; readonly files: ReadonlyArray<string> },
    ) =>
      Effect.gen(function* () {
        // A person may have cancelled while the provider worked; then nothing is downloaded.
        if ((yield* jobs.get(job.id)).job.status !== "running") return;
        const outcome = yield* saveResults(job, urls, local).pipe(
          Effect.map((paths) => ({ status: "done", resultPaths: paths }) as const),
          Effect.catch((reason: string) =>
            Effect.succeed({
              status: "failed",
              error: `${local === undefined ? "The provider" : "The graphics card"} made it, but it could not be saved: ${reason}`,
            } as const),
          ),
        );
        yield* settle(job.id, outcome);
      });

    // The loops

    const firstFrameUrl = (job: CampaignGenerationJob) =>
      Effect.gen(function* () {
        const frame = job.options.firstFrame;
        if (frame === undefined || isHttpsUrl(frame)) return frame;
        if (!IMAGE_FILE.test(frame))
          return yield* Effect.fail("The first frame must be a png, jpg or webp image.");
        const root = yield* rootFor(job);
        if (root === null) return yield* Effect.fail(NO_FOLDER);
        const { root: normalized, realRoot } = yield* openRoot(root);
        const target = yield* workspacePaths
          .resolveRelativePathWithinRoot({ workspaceRoot: normalized, relativePath: frame })
          .pipe(Effect.mapError(() => "The first frame must be inside the thread's folder."));
        const real = yield* fileSystem
          .realPath(target.absolutePath)
          .pipe(Effect.mapError(() => `${frame} was not found.`));
        const relative = path.relative(realRoot, real);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
          return yield* Effect.fail("The first frame must be inside the thread's folder.");
        }
        const info = yield* fileSystem
          .stat(real)
          .pipe(Effect.mapError(() => `${frame} could not be read.`));
        if (info.type !== "File" || Number(info.size) > FIRST_FRAME_MAX_BYTES) {
          return yield* Effect.fail("The first frame is not a file, or is over 8 MB.");
        }
        const bytes = yield* fileSystem
          .readFile(real)
          .pipe(Effect.mapError(() => `${frame} could not be read.`));
        const mime = MIME_FOR[path.extname(real).slice(1).toLowerCase()] ?? "image/png";
        // confirm against OpenRouter's video generation docs: a data address is accepted for frame_images
        // (MuAPI gets the same address and uploads it first; fal.ai takes it as is)
        return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
      });

    /**
     * The picture a video made on this computer starts from, as a real path. It may be named
     * relative to the thread's folder or by an absolute path; either way it must really sit inside
     * that folder once links are followed, and be a plain image file of a sensible size.
     */
    const firstFramePath = (job: CampaignGenerationJob) =>
      Effect.gen(function* () {
        const frame = job.options.firstFrame;
        if (frame === undefined || frame === "") return yield* Effect.fail(NEEDS_FIRST_FRAME);
        if (!IMAGE_FILE.test(frame)) {
          return yield* Effect.fail("The first frame must be a png, jpg or webp image.");
        }
        const root = yield* rootFor(job);
        if (root === null) return yield* Effect.fail(NO_FOLDER);
        const { root: normalized, realRoot } = yield* openRoot(root);
        const outside = "The first frame must be inside the thread's folder.";
        const candidate = path.isAbsolute(frame)
          ? frame
          : (yield* workspacePaths
              .resolveRelativePathWithinRoot({ workspaceRoot: normalized, relativePath: frame })
              .pipe(Effect.mapError(() => outside))).absolutePath;
        const real = yield* fileSystem
          .realPath(candidate)
          .pipe(Effect.mapError(() => `${path.basename(frame)} was not found.`));
        const relative = path.relative(realRoot, real);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
          return yield* Effect.fail(outside);
        }
        if (!IMAGE_FILE.test(real)) {
          return yield* Effect.fail("The first frame must be a png, jpg or webp image.");
        }
        const info = yield* fileSystem
          .stat(real)
          .pipe(Effect.mapError(() => `${path.basename(frame)} could not be read.`));
        if (
          info.type !== "File" ||
          Number(info.size) === 0 ||
          Number(info.size) > MAX_IMAGE_BYTES
        ) {
          return yield* Effect.fail("The first frame is not a file, is empty, or is over 40 MB.");
        }
        return real;
      });

    const runOne = (stored: GenerationStore.StoredGenerationJob) =>
      Effect.gen(function* () {
        const job = stored.job;
        const client = yield* campaigns
          .getClient(job.clientId)
          .pipe(Effect.mapError(() => "The client is gone."));
        const request: GenerationRequest = {
          kind: job.kind,
          model: job.model,
          prompt: job.prompt,
          options: job.options,
          // This computer's graphics card reads the still from disk; every other generator takes an address.
          ...(job.connector === "local-gpu"
            ? job.kind === "video"
              ? { firstFramePath: yield* firstFramePath(job) }
              : {}
            : { firstFrameUrl: yield* firstFrameUrl(job) }),
          engineClientId: client.publishingClientId,
          name: job.prompt.slice(0, 60),
        };
        // A connector that makes files on this computer gets its own folder, removed afterwards.
        const workDir =
          job.connector === "local-gpu"
            ? yield* fileSystem
                .makeTempDirectory({ prefix: "codewrench-localgen-" })
                .pipe(
                  Effect.mapError(
                    () =>
                      `A work folder for the ${job.kind === "video" ? "video" : "image"} could not be made.`,
                  ),
                )
            : undefined;
        const run = Effect.gen(function* () {
          const started = yield* connectors[job.connector].start({ ...request, workDir });
          if (started.kind === "uncertain") {
            yield* jobs.markUncertain(job.id, started.reason);
          } else if (started.kind === "waiting") {
            // No room yet: back in line with the reason, tried again in a few minutes.
            yield* jobs.hold(job.id, started.note);
          } else if (started.kind === "async") {
            yield* jobs
              .setProviderJobId(job.id, started.providerJobId)
              .pipe(
                Effect.catch(() =>
                  jobs.markUncertain(
                    job.id,
                    "The provider accepted the request, but its receipt could not be saved. Reconcile it in the provider dashboard; this job will not be resubmitted.",
                  ),
                ),
              );
          } else {
            yield* complete(
              job,
              started.urls,
              workDir === undefined || started.files === undefined
                ? undefined
                : { workDir, files: started.files },
            );
          }
        });
        yield* workDir === undefined
          ? run
          : run.pipe(
              Effect.ensuring(
                fileSystem.remove(workDir, { recursive: true, force: true }).pipe(Effect.ignore),
              ),
            );
      }).pipe(
        Effect.catch((reason: string | CampaignError) =>
          settle(stored.job.id, {
            status: "failed",
            error: typeof reason === "string" ? reason : reason.message,
          }),
        ),
      );

    /** A pass that fails is logged and tried again on the next tick; an interrupt still stops it. */
    const quietly = <E>(label: string, effect: Effect.Effect<void, E>): Effect.Effect<void> =>
      effect.pipe(
        Effect.orDie,
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(label, { cause: Cause.pretty(cause) }),
        ),
      );

    const queuedPass: Effect.Effect<void> = quietly(
      "generation start pass failed",
      startPass.withPermit(
        Effect.gen(function* () {
          const queued = (yield* jobs.byStatus("queued")).filter(
            (stored) => stored.job.connector !== "local-gpu",
          );
          yield* Effect.forEach(
            queued,
            (stored) =>
              Effect.gen(function* () {
                if (yield* jobs.claim(stored.job.id)) yield* runOne(stored);
              }),
            { concurrency: 3, discard: true },
          );
        }),
      ),
    );

    // Pictures made on this computer take minutes and share one graphics card, so they have their
    // own pass: one at a time, and never holding up the providers' jobs.
    const lastTried = new Map<string, number>();
    const localQueuedPass: Effect.Effect<void> = quietly(
      "local generation pass failed",
      localPass.withPermit(
        Effect.gen(function* () {
          const queued = (yield* jobs.byStatus("queued")).filter(
            (stored) => stored.job.connector === "local-gpu",
          );
          const current = yield* readSettings;
          for (const stored of queued) {
            const nowMs = yield* Clock.currentTimeMillis;
            const id = stored.job.id;
            if (
              stored.waitingSince !== null &&
              localGpuWaitExpired(stored.waitingSince, yield* now)
            ) {
              if (yield* jobs.claim(id)) {
                lastTried.delete(id);
                yield* settle(id, { status: "failed", error: GAVE_UP_WAITING });
              }
              continue;
            }
            const windowNote = localGpuWindowNote({
              start: current.campaignLocalGpuWindowStart,
              end: current.campaignLocalGpuWindowEnd,
              minuteOfDay: localMinuteOfDay(nowMs),
            });
            if (windowNote !== null) {
              if (stored.job.waitingNote !== windowNote) yield* jobs.hold(id, windowNote);
              continue;
            }
            if (
              (current.campaignLocalGpuWhenBusy === "wait" || stored.job.kind === "video") &&
              nowMs - (lastTried.get(id) ?? -BUSY_RETRY_MS) < BUSY_RETRY_MS
            ) {
              continue;
            }
            lastTried.set(id, nowMs);
            if (yield* jobs.claim(id)) yield* runOne(stored);
          }
        }),
      ),
    );

    const pollOne = (stored: GenerationStore.StoredGenerationJob) =>
      Effect.gen(function* () {
        const providerJobId = stored.providerJobId;
        if (providerJobId === null) return;
        const age = Date.parse(yield* now) - Date.parse(stored.job.updatedAt);
        const result = yield* connectors[stored.job.connector].poll(providerJobId).pipe(
          Effect.catch((reason: string) =>
            Effect.succeed(
              age > MAX_RUNNING_MS
                ? ({
                    state: "failed",
                    reason: `The provider did not finish within an hour (${reason}). It may still charge for it.`,
                  } as const)
                : ({ state: "running" } as const),
            ),
          ),
        );
        if (result.state === "done") yield* complete(stored.job, result.urls);
        else if (result.state === "failed")
          yield* settle(stored.job.id, { status: "failed", error: result.reason });
        else if (age > MAX_RUNNING_MS) {
          yield* settle(stored.job.id, {
            status: "failed",
            error: "The provider did not finish within an hour. It may still charge for it.",
          });
        }
      });

    const pollingPass: Effect.Effect<void> = quietly(
      "generation poll pass failed",
      pollPass.withPermit(
        Effect.gen(function* () {
          const running = yield* jobs.byStatus("running");
          yield* Effect.forEach(running, pollOne, { concurrency: 3, discard: true });
        }),
      ),
    );

    const tick: GenerationService["Service"]["tick"] = Effect.all(
      [queuedPass, localQueuedPass, pollingPass],
      {
        concurrency: 3,
        discard: true,
      },
    );

    const recover: GenerationService["Service"]["recover"] = quietly(
      "generation recovery failed",
      Effect.gen(function* () {
        const running = yield* jobs.byStatus("running");
        for (const stored of running) {
          if (stored.providerJobId !== null) continue;
          if (stored.job.connector === "local-gpu" || stored.job.connector === "local") {
            yield* settle(stored.job.id, { status: "failed", error: INTERRUPTED_LOCAL_GPU });
          } else {
            yield* jobs.markUncertain(stored.job.id, INTERRUPTED_WHILE_WAITING);
          }
        }
      }),
    );

    const begin: GenerationService["Service"]["begin"] = Effect.fn("GenerationService.begin")(
      function* () {
        yield* recover;
        yield* forkParked(
          queuedPass.pipe(Effect.repeat(Schedule.spaced(START_INTERVAL)), Effect.asVoid),
        );
        yield* forkParked(
          localQueuedPass.pipe(Effect.repeat(Schedule.spaced(START_INTERVAL)), Effect.asVoid),
        );
        yield* forkParked(
          pollingPass.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.asVoid),
        );
      },
    );

    const board: GenerationService["Service"]["board"] = (campaignId) =>
      Effect.gen(function* () {
        const clients = yield* campaigns.listClients;
        const selected =
          campaignId === undefined ? undefined : yield* campaigns.getCampaign(campaignId);
        const spend = yield* Effect.forEach(clients, (client) =>
          Effect.map(jobs.usedUsd(client.id), (usedUsd) => ({
            clientId: client.id,
            capUsd: client.monthlySpendCapUsd ?? null,
            usedUsd,
          })),
        );
        return {
          jobs: yield* jobs.listRecent({ clientId: selected?.clientId, limit: BOARD_JOB_LIMIT }),
          settings: yield* settingsView,
          spend,
        } satisfies CampaignGenerationBoard;
      });

    return GenerationService.of({
      campaignBudget: jobs.campaignBudget,
      reserveExternalExpense: jobs.reserveExternalExpense,
      startJob,
      approveJob,
      reconcileJob,
      cancelJob,
      getJob: (id) => Effect.map(jobs.get(id), (stored) => stored.job),
      listJobs: jobs.listRecent,
      settings: settingsView,
      setSettings,
      test,
      board,
      tick,
      recover,
      begin,
    });
  });

export const layerWith = (serviceOptions: GenerationServiceOptions) =>
  Layer.effect(GenerationService, make(serviceOptions));

export const layer = layerWith({});
