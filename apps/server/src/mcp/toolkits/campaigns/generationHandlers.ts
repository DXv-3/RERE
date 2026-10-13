import { CampaignError, type CampaignGenerationJob } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GenerationService from "../../../campaigns/generation/GenerationService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  GENERATION_STATUS_LIST_MAX,
  MediaGenerationToolkit,
  type GenerationJobResult,
} from "./generationTools.ts";

export const NEEDS_APPROVAL_OUTCOME =
  "A person has to approve this spend on the campaign board. Nothing has been spent yet. Tell the person it is waiting, and do not start it again.";

/** What the agent is told about a job, in words. */
function describeGeneration(job: CampaignGenerationJob): string {
  if (job.submissionState === "uncertain") {
    return "The provider may have accepted this request and charged for it. The allowance remains reserved. Ask a person to reconcile its receipt in the provider dashboard; do not submit another job.";
  }
  switch (job.status) {
    case "needs-approval":
      return NEEDS_APPROVAL_OUTCOME;
    case "queued":
    case "running":
      return "It is making the file now. You will get a message in this conversation with the file path when it finishes. Do not wait on it or start another.";
    case "done":
      return "Done. Look at the file with media_inspect, then attach it to a post with campaign_post_save (mediaPaths).";
    case "failed":
      return "It failed. Do not start it again in a loop: tell the person why and ask what they want.";
    case "cancelled":
      return "A person cancelled it.";
  }
}

const resultOf = (job: CampaignGenerationJob): GenerationJobResult => ({
  jobId: job.id,
  kind: job.kind,
  status: job.status,
  model: job.model,
  estimatedUsd: job.estimatedUsd,
  estimateNote: job.estimateNote,
  ...(job.reservedUsd === undefined ? {} : { reservedUsd: job.reservedUsd }),
  ...(job.allowanceUsd === undefined ? {} : { allowanceUsd: job.allowanceUsd }),
  ...(job.submissionState === undefined ? {} : { submissionState: job.submissionState }),
  resultPaths: job.resultPaths,
  ...(job.error === undefined ? {} : { error: job.error }),
  outcome: describeGeneration(job),
});

const guarded = <A, E, R>(
  use: (scope: McpInvocationContext.McpInvocationScope) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("campaigns")) {
      return yield* new CampaignError({
        reason: "not_allowed",
        message: McpInvocationContext.capabilityDeniedMessage(
          scope,
          "campaigns",
          "This credential cannot use campaigns.",
        ),
      });
    }
    return yield* use(scope);
  });

/** A job belongs to the thread that asked for it; another thread's jobs are not shown. */
const ownedBy = (scope: McpInvocationContext.McpInvocationScope) => (job: CampaignGenerationJob) =>
  job.requestedBy.kind === "agent" && job.requestedBy.threadId === scope.threadId;

export const MediaGenerationToolkitHandlersLive = MediaGenerationToolkit.toLayer({
  media_generate_image: (input) =>
    guarded((scope) =>
      Effect.gen(function* () {
        const generation = yield* GenerationService.GenerationService;
        const job = yield* generation.startJob({
          actor: { kind: "agent", threadId: scope.threadId },
          kind: "image",
          clientId: input.clientId,
          ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
          prompt: input.prompt,
          options: input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio },
          sourceThreadId: scope.threadId,
          ...(input.allowanceUsd === undefined
            ? {}
            : { allowanceUsd: input.allowanceUsd, forceApproval: true }),
        });
        return resultOf(job);
      }),
    ),
  media_generate_video: (input) =>
    guarded((scope) =>
      Effect.gen(function* () {
        const generation = yield* GenerationService.GenerationService;
        if (input.fromJobId !== undefined) {
          // Only a picture this conversation asked for may start a video.
          const earlier = yield* generation.getJob(input.fromJobId);
          if (!ownedBy(scope)(earlier)) {
            return yield* new CampaignError({
              reason: "not_found",
              message: "That generation job was not found.",
            });
          }
        }
        const job = yield* generation.startJob({
          actor: { kind: "agent", threadId: scope.threadId },
          kind: "video",
          clientId: input.clientId,
          ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
          prompt: input.prompt,
          options: {
            ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
            ...(input.durationSeconds === undefined
              ? {}
              : { durationSeconds: input.durationSeconds }),
            ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
            ...(input.generateAudio === undefined ? {} : { generateAudio: input.generateAudio }),
            ...(input.firstFrame === undefined ? {} : { firstFrame: input.firstFrame }),
            ...(input.fromJobId === undefined ? {} : { firstFrameJobId: input.fromJobId }),
          },
          sourceThreadId: scope.threadId,
          ...(input.allowanceUsd === undefined
            ? {}
            : { allowanceUsd: input.allowanceUsd, forceApproval: true }),
        });
        return resultOf(job);
      }),
    ),
  media_generation_status: (input) =>
    guarded((scope) =>
      Effect.gen(function* () {
        const generation = yield* GenerationService.GenerationService;
        if (input.jobId !== undefined) {
          const job = yield* generation.getJob(input.jobId);
          if (!ownedBy(scope)(job)) {
            return yield* new CampaignError({
              reason: "not_found",
              message: "That generation job was not found.",
            });
          }
          return { jobs: [resultOf(job)] };
        }
        // Newest first; only this thread's own jobs, out of the latest few hundred.
        const recent = yield* generation.listJobs({ limit: 200 });
        return {
          jobs: recent.filter(ownedBy(scope)).slice(0, GENERATION_STATUS_LIST_MAX).map(resultOf),
        };
      }),
    ),
});
