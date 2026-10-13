import * as NodeCrypto from "node:crypto";
import {
  CampaignError,
  CampaignGeneratorService,
  CampaignPlatform,
  type CampaignCommandResult,
  type CampaignGenerationJob,
  type CampaignPostCreatedBy,
  type ContentStudio,
  type StudioAsset,
  type StudioCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { getCampaignModelCapability } from "@t3tools/shared/campaignModelCapabilities";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CampaignStore from "../CampaignStore.ts";
import * as GenerationService from "../generation/GenerationService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as MediaService from "../../media/MediaService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as StudioStore from "./StudioStore.ts";
import * as StudioAssetFiles from "./StudioAssetFiles.ts";
import * as StudioMedia from "./StudioMedia.ts";

const failure = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const id = () => NodeCrypto.randomUUID();
const isGenerator = Schema.is(CampaignGeneratorService);
const isCampaignError = Schema.is(CampaignError);
const isStudioMediaError = Schema.is(StudioMedia.StudioMediaError);
const isPlatform = Schema.is(CampaignPlatform);
export const studioCommandNeedsApproval = (command: StudioCommand) =>
  ![
    "studio.save",
    "studio.import",
    "studio.importUploaded",
    "studio.asset.reuse",
    "studio.generate",
    "studio.render",
  ].includes(command.command);

export class StudioService extends Context.Service<
  StudioService,
  {
    readonly get: (campaignId: string) => Effect.Effect<ContentStudio, CampaignError>;
    readonly run: (
      actor: CampaignPostCreatedBy,
      command: StudioCommand,
    ) => Effect.Effect<CampaignCommandResult, CampaignError>;
  }
>()("t3/campaigns/studio/StudioService") {}

const make = Effect.gen(function* () {
  const store = yield* StudioStore.StudioStore;
  const assetFiles = yield* StudioAssetFiles.StudioAssetFiles;
  const campaigns = yield* CampaignStore.CampaignStore;
  const generation = yield* GenerationService.GenerationService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const media = yield* MediaService.MediaService;
  const production = yield* StudioMedia.StudioMedia;
  const paths = yield* WorkspacePaths.WorkspacePaths;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  yield* store.recoverRenders;
  const root = (threadId: ThreadId | null) =>
    Effect.gen(function* () {
      if (threadId === null)
        return yield* failure("invalid", "Choose a campaign conversation and workspace first.");
      const shell = yield* threads.getThreadShell(threadId);
      if (!shell || shell.deletedAt !== null)
        return yield* failure(
          "not_found",
          "The campaign conversation is unavailable. Choose another conversation.",
        );
      const project = yield* projects.getById(shell.projectId);
      if (Option.isNone(project))
        return yield* failure("not_found", "The campaign workspace is unavailable.");
      return { cwd: shell.worktreePath ?? project.value.workspaceRoot, threadId };
    }).pipe(
      Effect.mapError((e) =>
        isCampaignError(e) ? e : failure("unavailable", "Could not open the campaign workspace."),
      ),
    );
  const assertRevision = (state: ContentStudio, revision: number) =>
    state.revision === revision
      ? Effect.void
      : Effect.fail(failure("conflict", "The studio changed. Refresh before continuing."));
  const asResult = (studio: ContentStudio): CampaignCommandResult => ({ kind: "studio", studio });
  const imported = (state: ContentStudio, jobs: ReadonlyArray<CampaignGenerationJob>) =>
    jobs.flatMap((job) => {
      const link = state.generationLinks.find((l) => l.jobId === job.id);
      if (!link || job.status !== "done" || !job.sourceThreadId) return [];
      return job.resultPaths
        .filter((file) => !state.assets.some((a) => a.jobId === job.id && a.file === file))
        .map((file): StudioAsset => ({
          id: id(),
          sceneId: state.scenes.some((s) => s.id === link.sceneId) ? link.sceneId : null,
          kind: job.kind,
          file,
          sourceThreadId: job.sourceThreadId!,
          jobId: job.id,
          prompt: job.prompt,
          model: job.model,
          connector: job.connector,
          createdAt: job.updatedAt,
          approved: false,
        }));
    });
  const get = (campaignId: string) =>
    Effect.gen(function* () {
      const state = yield* store.get(campaignId);
      const jobs = yield* Effect.forEach(
        state.generationLinks,
        (l) => generation.getJob(l.jobId).pipe(Effect.option),
        { concurrency: 4 },
      );
      const ready = jobs.flatMap((o) => (Option.isSome(o) ? [o.value] : []));
      const current =
        imported(state, ready).length === 0
          ? state
          : yield* store.modify(campaignId, undefined, (current) => ({
              ...current,
              assets: [...current.assets, ...imported(current, ready)],
            }));
      return { ...current, budget: yield* generation.campaignBudget(campaignId) };
    });
  const run: StudioService["Service"]["run"] = (actor, command) =>
    Effect.gen(function* () {
      if (actor.kind === "agent" && studioCommandNeedsApproval(command))
        return yield* failure("not_allowed", "A person must approve this Studio action.");
      const state = yield* get(command.campaignId);
      if (
        actor.kind === "agent" &&
        state.brief.sourceThreadId !== null &&
        state.brief.sourceThreadId !== actor.threadId
      )
        return yield* failure(
          "not_allowed",
          "Use the conversation linked to this campaign to edit its studio.",
        );
      switch (command.command) {
        case "studio.save": {
          if (
            actor.kind === "agent" &&
            command.brief.budgetUsd !== undefined &&
            (command.brief.budgetUsd ?? null) !== (state.brief.budgetUsd ?? null)
          )
            return yield* failure(
              "not_allowed",
              "Only a person can change the campaign spending budget.",
            );
          if (actor.kind === "agent" && command.brief.sourceThreadId !== actor.threadId)
            return yield* failure("not_allowed", "An agent can only link its own conversation.");
          if (command.brief.sourceThreadId !== null) yield* root(command.brief.sourceThreadId);
          return asResult(
            yield* store.modify(command.campaignId, command.expectedRevision, (current) => ({
              ...current,
              brief: {
                ...command.brief,
                // Omission is creative-only editing, never permission to remove a spending cap.
                ...(command.brief.budgetUsd === undefined && current.brief.budgetUsd !== undefined
                  ? { budgetUsd: current.brief.budgetUsd }
                  : {}),
              },
              scenes: command.scenes,
            })),
          );
        }
        case "studio.import": {
          yield* assertRevision(state, command.expectedRevision);
          const workspace = yield* root(state.brief.sourceThreadId);
          if (command.sceneId && !state.scenes.some((s) => s.id === command.sceneId))
            return yield* failure("invalid", "That scene no longer exists.");
          if (command.kind === "audio") {
            const resolved = yield* paths.resolveRelativePathWithinRoot({
              workspaceRoot: workspace.cwd,
              relativePath: command.file,
            });
            const realRoot = yield* fs.realPath(workspace.cwd);
            const realFile = yield* fs.realPath(resolved.absolutePath);
            const relative = path.relative(realRoot, realFile);
            const stat = yield* fs.stat(realFile);
            if (
              relative.startsWith("..") ||
              path.isAbsolute(relative) ||
              stat.type !== "File" ||
              Number(stat.size) > 100 * 1024 * 1024 ||
              !/[.](wav|mp3|m4a|aac|ogg|flac)$/i.test(realFile)
            )
              return yield* failure(
                "invalid",
                "Choose an audio file inside the campaign workspace, up to 100 MB.",
              );
          } else {
            const resolved = yield* media.resolveFile({
              cwd: workspace.cwd,
              relativePath: command.file,
            });
            if (resolved.kind !== command.kind)
              return yield* failure("invalid", "The file type does not match this asset.");
            yield* media.probe({ cwd: workspace.cwd, relativePath: command.file });
          }
          const asset: StudioAsset = {
            id: id(),
            sceneId: command.sceneId ?? null,
            kind: command.kind,
            file: command.file,
            sourceThreadId: workspace.threadId,
            jobId: null,
            prompt: "",
            model: "",
            connector: "import",
            createdAt: yield* now,
            approved: false,
          };
          return asResult(
            yield* store.modify(command.campaignId, command.expectedRevision, (s) => ({
              ...s,
              assets: [...s.assets, asset],
            })),
          );
        }
        case "studio.importUploaded":
        case "studio.asset.reuse": {
          yield* assertRevision(state, command.expectedRevision);
          const workspace = yield* root(state.brief.sourceThreadId);
          let sourceAsset: StudioAsset | undefined;
          let sourceCampaignId: string | undefined;
          if (command.command === "studio.asset.reuse") {
            const sourceStudio = yield* store.get(command.sourceCampaignId);
            sourceAsset = sourceStudio.assets.find(
              (asset) => asset.id === command.assetId && asset.approved,
            );
            if (!sourceAsset)
              return yield* failure("not_allowed", "Choose an approved source asset.");
            sourceCampaignId = command.sourceCampaignId;
          }
          const sourceWorkspace = sourceAsset ? yield* root(sourceAsset.sourceThreadId) : null;
          const kind =
            command.command === "studio.importUploaded" ? command.kind : sourceAsset!.kind;
          const copied = yield* assetFiles.copy({
            cwd: workspace.cwd,
            kind,
            source:
              command.command === "studio.importUploaded"
                ? { attachmentId: command.attachmentId }
                : { cwd: sourceWorkspace!.cwd, file: sourceAsset!.file },
          });
          return yield* Effect.gen(function* () {
            if (kind !== "audio")
              yield* media.probe({ cwd: workspace.cwd, relativePath: copied.file });
            const asset: StudioAsset = {
              id: id(),
              sceneId: null,
              kind,
              file: copied.file,
              sourceThreadId: workspace.threadId,
              jobId: sourceAsset?.jobId ?? null,
              prompt: sourceAsset?.prompt ?? "",
              model: sourceAsset?.model ?? "",
              connector: sourceAsset?.connector ?? "upload",
              createdAt: yield* now,
              approved: false,
              ...(sourceAsset && sourceCampaignId
                ? {
                    provenance: {
                      campaignId: sourceCampaignId,
                      assetId: sourceAsset.id,
                      sourceThreadId: sourceAsset.sourceThreadId,
                      file: sourceAsset.file,
                    },
                  }
                : {}),
            };
            return asResult(
              yield* store.modify(command.campaignId, command.expectedRevision, (current) => ({
                ...current,
                assets: [...current.assets, asset],
              })),
            );
          }).pipe(Effect.onError(() => copied.discard));
        }
        case "studio.asset.approve": {
          if (!state.assets.some((a) => a.id === command.assetId))
            return yield* failure("not_found", "That asset is unavailable.");
          return asResult(
            yield* store.modify(command.campaignId, undefined, (s) => ({
              ...s,
              assets: s.assets.map((a) =>
                a.id === command.assetId ? { ...a, approved: command.approved ?? true } : a,
              ),
            })),
          );
        }
        case "studio.generate": {
          yield* assertRevision(state, command.expectedRevision);
          const workspace = yield* root(state.brief.sourceThreadId);
          const campaign = yield* campaigns.getCampaign(command.campaignId);
          const selected = state.scenes.filter((s) => command.sceneIds.includes(s.id));
          if (selected.length !== new Set(command.sceneIds).size)
            return yield* failure("invalid", "One of the selected scenes no longer exists.");
          for (const scene of selected) {
            if (!isGenerator(scene.connector))
              return yield* failure("invalid", "Choose a supported generator for every scene.");
            const capability = getCampaignModelCapability(scene.connector, scene.model);
            if (!capability || capability.kind !== "video")
              return yield* failure("invalid", "Choose a supported video model for every scene.");
            const resolution = capability.resolutions.find((r) => r === scene.resolution);
            if (capability.resolutions.length > 0 && !resolution)
              return yield* failure("invalid", "Choose a supported resolution for this model.");
            const job = yield* generation.startJob({
              actor,
              kind: "video",
              clientId: campaign.clientId,
              campaignId: campaign.id,
              sourceThreadId: workspace.threadId,
              prompt: scene.prompt,
              connector: scene.connector,
              model: scene.model,
              forceApproval: true,
              requestKey: `studio:${campaign.id}:${command.expectedRevision}:${scene.id}`,
              ...(scene.allowanceUsd === null ? {} : { allowanceUsd: scene.allowanceUsd }),
              options: {
                ...(capability.aspectRatios.length ? { aspectRatio: "9:16" as const } : {}),
                durationSeconds: scene.durationSeconds,
                ...(resolution ? { resolution } : {}),
                ...(capability.audio === "toggle" ? { generateAudio: scene.generateAudio } : {}),
                ...(scene.referenceImage ? { firstFrame: scene.referenceImage } : {}),
              },
            });
            yield* store.modify(campaign.id, undefined, (s) => ({
              ...s,
              generationLinks: s.generationLinks.some((l) => l.jobId === job.id)
                ? s.generationLinks
                : [...s.generationLinks, { sceneId: scene.id, jobId: job.id }],
            }));
          }
          return asResult(yield* get(campaign.id));
        }
        case "studio.render": {
          yield* assertRevision(state, command.expectedRevision);
          const workspace = yield* root(state.brief.sourceThreadId);
          if (state.renders.some((r) => r.status === "rendering"))
            return yield* failure("conflict", "A render is already running for this campaign.");
          const seconds = state.scenes.reduce((n, s) => n + s.durationSeconds, 0);
          if (seconds < 15 || seconds > 60)
            return yield* failure(
              "invalid",
              "The storyboard must total 15–60 seconds before rendering.",
            );
          if (command.aspectRatio !== "9:16" && !command.fit)
            return yield* failure(
              "invalid",
              "Choose crop or fit before exporting a different aspect ratio.",
            );
          const scenes = [];
          const assetIds: string[] = [];
          for (const scene of state.scenes) {
            const asset = state.assets.find(
              (a) =>
                a.id === scene.selectedAssetId &&
                a.kind === "video" &&
                a.sourceThreadId === workspace.threadId,
            );
            if (!asset)
              return yield* failure(
                "invalid",
                `Select a video for ${scene.title || "every scene"} before rendering.`,
              );
            assetIds.push(asset.id);
            scenes.push({
              file: asset.file,
              durationSeconds: scene.durationSeconds,
              onScreenText: scene.onScreenText,
              ...(scene.startSeconds !== undefined ? { start: scene.startSeconds } : {}),
              ...(scene.captions ? { captions: scene.captions } : {}),
            });
          }
          const audio = command.audioAssetId
            ? state.assets.find(
                (a) =>
                  a.id === command.audioAssetId &&
                  a.kind === "audio" &&
                  a.sourceThreadId === workspace.threadId,
              )
            : undefined;
          if (command.audioAssetId && !audio)
            return yield* failure("invalid", "Choose audio from the campaign workspace.");
          const renderId = id();
          const createdAt = yield* now;
          const started = yield* store.modify(
            command.campaignId,
            command.expectedRevision,
            (s) => ({
              ...s,
              renders: [
                ...s.renders,
                {
                  id: renderId,
                  revision: state.revision,
                  status: "rendering",
                  file: null,
                  sourceThreadId: workspace.threadId,
                  error: null,
                  approvedAt: null,
                  createdAt,
                  aspectRatio: command.aspectRatio,
                  sceneAssetIds: assetIds,
                  snapshot: {
                    scenes: state.scenes,
                    fit: command.fit ?? "crop",
                    audioAssetId: audio?.id ?? null,
                    keepSourceAudio: command.keepSourceAudio ?? false,
                  },
                },
              ],
            }),
          );
          yield* production
            .render({
              cwd: workspace.cwd,
              scenes,
              aspectRatio: command.aspectRatio,
              keepSourceAudio: command.keepSourceAudio ?? false,
              ...(command.fit ? { fit: command.fit } : {}),
              ...(audio ? { audioFile: audio.file } : {}),
            })
            .pipe(
              Effect.matchEffect({
                onSuccess: (result) =>
                  store.modify(command.campaignId, undefined, (s) => ({
                    ...s,
                    renders: s.renders.map((r) =>
                      r.id === renderId ? { ...r, status: "completed", file: result.file } : r,
                    ),
                  })),
                onFailure: (error) =>
                  store.modify(command.campaignId, undefined, (s) => ({
                    ...s,
                    renders: s.renders.map((r) =>
                      r.id === renderId ? { ...r, status: "failed", error: error.message } : r,
                    ),
                  })),
              }),
              Effect.catchCause((cause) =>
                Effect.logWarning("Studio render could not record its result", {
                  renderId,
                  cause,
                }),
              ),
              Effect.forkIn(scope),
            );
          return asResult(started);
        }
        case "studio.render.approve": {
          const render = state.renders.find((r) => r.id === command.renderId);
          if (!render || render.status !== "completed" || !render.file)
            return yield* failure("invalid", "Only a completed render can be approved.");
          const approvedAt = yield* now;
          return asResult(
            yield* store.modify(command.campaignId, undefined, (s) => ({
              ...s,
              renders: s.renders.map((r) =>
                r.id === render.id
                  ? { ...r, approvedAt: command.approved === false ? null : approvedAt }
                  : r,
              ),
            })),
          );
        }
        case "studio.post": {
          const render = state.renders.find((r) => r.id === command.renderId);
          if (!render?.file || !render.approvedAt || render.status !== "completed")
            return yield* failure(
              "not_allowed",
              "Review and approve this render before creating posts.",
            );
          if (!command.platforms.every(isPlatform))
            return yield* failure("invalid", "Choose supported social platforms.");
          const post = yield* campaigns.savePost(actor, {
            campaignId: command.campaignId,
            platforms: command.platforms,
            captions: command.captions,
            mediaPaths: [render.file],
            mediaUrls: [],
            sourceThreadId: render.sourceThreadId,
            ...(command.scheduledAt ? { scheduledAt: command.scheduledAt } : {}),
          });
          return { kind: "post", post } as const;
        }
        case "studio.narration.reconcile": {
          const attempt = state.narrations?.find((n) => n.id === command.narrationId);
          const asset = state.assets.find((a) => a.id === command.assetId);
          if (!attempt || attempt.status !== "uncertain")
            return yield* failure(
              "conflict",
              "Only an uncertain narration attempt needs reconciliation.",
            );
          if (!asset || asset.kind !== "audio" || asset.sourceThreadId !== attempt.sourceThreadId)
            return yield* failure(
              "invalid",
              "Import the recovered audio into the original narration workspace first.",
            );
          const updatedAt = yield* now;
          return asResult(
            yield* store.modify(command.campaignId, state.revision, (s) => ({
              ...s,
              narrations: (s.narrations ?? []).map((n) =>
                n.id === attempt.id
                  ? { ...n, status: "completed", assetId: asset.id, error: null, updatedAt }
                  : n,
              ),
            })),
          );
        }
        case "studio.narrate": {
          yield* assertRevision(state, command.expectedRevision);
          const workspace = yield* root(state.brief.sourceThreadId);
          if (!command.text.trim() || command.allowanceUsd <= 0)
            return yield* failure(
              "invalid",
              "Enter narration and an explicit positive spending allowance.",
            );
          const voiceId = command.voiceId ?? "JBFqnCBsd6RMkjVDRZzb";
          const previous = state.narrations?.find((n) => n.id === command.requestId);
          if (
            previous &&
            (previous.text !== command.text ||
              previous.voiceId !== voiceId ||
              previous.allowanceUsd !== command.allowanceUsd ||
              previous.sourceThreadId !== workspace.threadId)
          )
            return yield* failure(
              "conflict",
              "This request ID belongs to a different approved narration attempt.",
            );
          if (previous && previous.status !== "failed")
            return yield* failure(
              "conflict",
              "This narration was already submitted or is in progress. Review its saved status; it will not be resubmitted.",
            );
          const at = yield* now;
          yield* store.modify(command.campaignId, command.expectedRevision, (s) => ({
            ...s,
            narrations: [
              ...(s.narrations ?? []).filter((n) => n.id !== command.requestId),
              {
                id: command.requestId,
                status: "preflight",
                text: command.text,
                voiceId,
                model: "eleven_multilingual_v2",
                sourceThreadId: workspace.threadId,
                allowanceUsd: command.allowanceUsd,
                expenseId: null,
                assetId: null,
                providerRequestId: null,
                confirmedUsd: null,
                error: null,
                createdAt: previous?.createdAt ?? at,
                updatedAt: at,
              },
            ],
          }));
          let expenseId: string | null = null;
          const update = (change: Partial<NonNullable<ContentStudio["narrations"]>[number]>) =>
            Effect.gen(function* () {
              const updatedAt = yield* now;
              return yield* store.modify(command.campaignId, undefined, (s) => ({
                ...s,
                narrations: (s.narrations ?? []).map((n) =>
                  n.id === command.requestId ? { ...n, ...change, updatedAt } : n,
                ),
              }));
            });
          return yield* Effect.gen(function* () {
            const campaign = yield* campaigns.getCampaign(command.campaignId);
            yield* production.checkNarration({ cwd: workspace.cwd, text: command.text, voiceId });
            const reservation = yield* generation.reserveExternalExpense({
              clientId: campaign.clientId,
              campaignId: campaign.id,
              requestKey: `studio-narration:${campaign.id}:${command.requestId}`,
              allowanceUsd: command.allowanceUsd,
              label: "ElevenLabs narration",
            });
            expenseId = reservation.id;
            if (!reservation.created)
              return yield* failure(
                "conflict",
                "This narration allowance was already reserved. Check ElevenLabs history; the paid request will not be repeated.",
              );
            // Persist the ambiguous boundary before the paid call. Any later failure retains the
            // reservation and requires reconciliation, including a successful response lost locally.
            yield* update({ status: "submitting", expenseId });
            const result = yield* production.narration({
              cwd: workspace.cwd,
              text: command.text,
              voiceId,
            });
            const asset: StudioAsset = {
              id: id(),
              sceneId: null,
              kind: "audio",
              file: result.file,
              sourceThreadId: workspace.threadId,
              jobId: null,
              prompt: command.text,
              model: "eleven_multilingual_v2",
              connector: "elevenlabs",
              createdAt: yield* now,
              approved: false,
            };
            const updatedAt = yield* now;
            return asResult(
              yield* store.modify(command.campaignId, undefined, (s) => ({
                ...s,
                assets: [...s.assets, asset],
                narrations: (s.narrations ?? []).map((n) =>
                  n.id === command.requestId
                    ? {
                        ...n,
                        status: "completed",
                        assetId: asset.id,
                        providerRequestId: result.providerRequestId ?? null,
                        updatedAt,
                      }
                    : n,
                ),
              })),
            );
          }).pipe(
            Effect.onInterrupt(() =>
              store
                .modify(command.campaignId, undefined, (s) => ({
                  ...s,
                  narrations: (s.narrations ?? []).map((n) =>
                    n.id === command.requestId &&
                    (n.status === "preflight" || n.status === "submitting")
                      ? {
                          ...n,
                          status: expenseId === null ? "failed" : "uncertain",
                          expenseId,
                          error:
                            expenseId === null
                              ? "Preflight was interrupted. No paid request was submitted; retry is safe."
                              : "Submission was interrupted. Check ElevenLabs history before any new paid request.",
                        }
                      : n,
                  ),
                }))
                .pipe(Effect.ignore),
            ),
            Effect.catch((error) =>
              update({
                status: expenseId === null ? "failed" : "uncertain",
                expenseId,
                error:
                  expenseId === null
                    ? isCampaignError(error) || isStudioMediaError(error)
                      ? error.message
                      : "Preflight failed. No paid request was submitted."
                    : "The provider may have accepted and charged this request. Check ElevenLabs history and recover the existing audio; do not submit it again.",
              }).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );
        }
      }
    }).pipe(
      Effect.flatMap((result): Effect.Effect<CampaignCommandResult, CampaignError> =>
        result.kind === "studio"
          ? generation
              .campaignBudget(command.campaignId)
              .pipe(Effect.map((budget) => ({ ...result, studio: { ...result.studio, budget } })))
          : Effect.succeed(result),
      ),
      Effect.mapError((e) =>
        isCampaignError(e)
          ? e
          : isStudioMediaError(e)
            ? failure(e.reason === "invalid_input" ? "invalid" : "unavailable", e.message)
            : failure(
                "unavailable",
                "This Studio action could not complete. Check the source files and connection, then review the saved job before retrying.",
              ),
      ),
    );
  return StudioService.of({ get, run });
});
export const layer = Layer.effect(StudioService, make);
