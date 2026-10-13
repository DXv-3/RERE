import type {
  CampaignGenerationKind,
  CampaignGenerationOptions,
  CampaignGeneratorService,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/** What a connector is asked to make. Options are already filled in and checked by the service. */
export interface GenerationRequest {
  readonly kind: CampaignGenerationKind;
  readonly model: string;
  readonly prompt: string;
  readonly options: CampaignGenerationOptions;
  /** An https or data address of the first frame, already read from the project folder if it was a file. */
  readonly firstFrameUrl?: string | undefined;
  /**
   * An image file on this computer that the service has checked sits inside the thread's project
   * folder. Only the graphics card reads it: it is the first frame of a video made there.
   */
  readonly firstFramePath?: string | undefined;
  /** The client's id in the marketing engine. Only that connector reads it. */
  readonly engineClientId?: string | undefined;
  readonly name: string;
  /**
   * An empty folder the service made for this job, which it removes afterwards. A connector that
   * makes a file on this computer writes it here and names it in `files`.
   */
  readonly workDir?: string | undefined;
}

/**
 * A provider that answers at once (images, the engine, a local server) returns `finished`. One that
 * takes a while (OpenRouter video) returns the id to poll. An id is stored so a restart polls the
 * same job again and never submits it twice.
 */
export type GenerationStartResult =
  | { readonly kind: "uncertain"; readonly reason: string }
  | { readonly kind: "async"; readonly providerJobId: string }
  /** Not started: the graphics card has no room yet. The job stays queued and is tried again. */
  | { readonly kind: "waiting"; readonly note: string }
  | {
      readonly kind: "finished";
      readonly urls: ReadonlyArray<string>;
      /** Image files inside `workDir`. The service moves them into the project folder. */
      readonly files?: ReadonlyArray<string> | undefined;
    };

export type GenerationPollResult =
  | { readonly state: "running" }
  | { readonly state: "done"; readonly urls: ReadonlyArray<string> }
  | { readonly state: "failed"; readonly reason: string };

/** A check or download result. `notes` are plain-word lines for the person, one per line. */
export type GenerationTestResult =
  | { readonly ok: true; readonly notes?: string | undefined }
  | { readonly ok: false; readonly reason: string; readonly notes?: string | undefined };

export interface GenerationEstimateResult {
  readonly usd: number | null;
  readonly note: string;
}

/**
 * Errors are plain sentences for the person. An ambiguous submit returns `uncertain`,
 * retains its reservation and must never be submitted again automatically. A `poll` error means "could not find out right now"; the job is polled again.
 */
export interface GenerationConnector {
  readonly kind: CampaignGeneratorService;
  readonly estimate: (request: GenerationRequest) => GenerationEstimateResult;
  readonly start: (request: GenerationRequest) => Effect.Effect<GenerationStartResult, string>;
  readonly poll: (providerJobId: string) => Effect.Effect<GenerationPollResult, string>;
  /** `kind` picks which of the graphics card's two models is checked; others ignore it. */
  readonly test: (kind?: CampaignGenerationKind) => Effect.Effect<GenerationTestResult>;
  /** Fetches what the connector needs before its first job. Only the local graphics card has one. */
  readonly download?: (kind?: CampaignGenerationKind) => Effect.Effect<GenerationTestResult>;
}
