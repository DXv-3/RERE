import * as StudioAssetFiles from "./StudioAssetFiles.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CampaignError,
  ThreadId,
  type CampaignGenerationJob,
  type StudioScene,
  type ContentStudio,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as CampaignStore from "../CampaignStore.ts";
import * as CampaignThreadNotifier from "../CampaignThreadNotifier.ts";
import * as GenerationService from "../generation/GenerationService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as MediaService from "../../media/MediaService.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as StudioStore from "./StudioStore.ts";
import * as StudioService from "./StudioService.ts";
import * as StudioMedia from "./StudioMedia.ts";
const threadId = ThreadId.make("studio-thread");
const person = { kind: "person" } as const;
const scene = (id: string): StudioScene => ({
  id,
  title: id,
  durationSeconds: 8,
  prompt: "A warm cafe, slow dolly",
  referenceImage: null,
  narration: "Fresh coffee",
  onScreenText: "Fresh coffee",
  selectedAssetId: null,
  connector: "fal",
  model: "fal-ai/veo3.1",
  resolution: "720p",
  generateAudio: false,
  allowanceUsd: null,
});
const harness = <E>(
  work: (input: {
    service: StudioService.StudioService["Service"];
    store: StudioStore.StudioStore["Service"];
    campaigns: CampaignStore.CampaignStore["Service"];
    initial: ContentStudio;
    jobs: Map<string, CampaignGenerationJob>;
    requests: GenerationService.StartGeneration[];
    rendered: StudioMedia.StudioRenderInput[];
    narrationCalls: () => number;
    reservations: Set<string>;
    copiedAssets: Parameters<StudioAssetFiles.StudioAssetFiles["Service"]["copy"]>[0][];
    discardedAssets: string[];
  }) => Effect.Effect<void, E>,
  mediaOverrides: Partial<StudioMedia.StudioMedia["Service"]> = {},
  beforeCopyReturns: Effect.Effect<void> = Effect.void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const jobs = new Map<string, CampaignGenerationJob>();
      const requests: GenerationService.StartGeneration[] = [];
      const rendered: StudioMedia.StudioRenderInput[] = [];
      const paid = new Set<string>();
      const copiedAssets: Parameters<StudioAssetFiles.StudioAssetFiles["Service"]["copy"]>[0][] =
        [];
      const discardedAssets: string[] = [];
      let narrationCalls = 0;
      const campaigns = CampaignStore.layer.pipe(
        Layer.provide(
          Layer.succeed(CampaignThreadNotifier.CampaignThreadNotifier, { tell: () => Effect.void }),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
      );
      const stores = StudioStore.layer.pipe(Layer.provideMerge(campaigns));
      const generation = Layer.mock(GenerationService.GenerationService)({
        campaignBudget: () =>
          Effect.succeed({
            budgetUsd: null,
            reservedUsd: 0,
            availableUsd: null,
            confirmedUsd: null,
            unreportedCount: 0,
            unresolvedSubmissions: 0,
          }),
        startJob: (input) =>
          Effect.sync(() => {
            requests.push(input);
            const existing = [...jobs.values()].find((j) => j.requestKey === input.requestKey);
            if (existing) return existing;
            const job: CampaignGenerationJob = {
              id: `job-${jobs.size + 1}`,
              clientId: input.clientId,
              campaignId: input.campaignId,
              kind: input.kind,
              connector: input.connector ?? "fal",
              model: input.model ?? "model",
              prompt: input.prompt,
              options: input.options ?? {},
              status: "needs-approval",
              estimatedUsd: 0.8,
              estimateNote: "test",
              reservedUsd: 0.8,
              resultPaths: [],
              requestedBy: input.actor,
              sourceThreadId: input.sourceThreadId,
              requestKey: input.requestKey,
              createdAt: "2026-10-08T00:00:00Z",
              updatedAt: "2026-10-08T00:00:00Z",
            };
            jobs.set(job.id, job);
            return job;
          }),
        getJob: (id) =>
          jobs.has(id)
            ? Effect.succeed(jobs.get(id)!)
            : Effect.fail(new CampaignError({ reason: "not_found", message: "Missing job" })),
        reserveExternalExpense: (input) =>
          Effect.sync(() => {
            const created = !paid.has(input.requestKey);
            paid.add(input.requestKey);
            return { id: input.requestKey, created, allowanceUsd: input.allowanceUsd };
          }),
      });
      const production = Layer.mock(StudioMedia.StudioMedia)({
        checkNarration: () => Effect.void,
        render: (input) =>
          Effect.sync(() => {
            rendered.push(input);
            return { file: "render.mp4", probe: {} as never };
          }),
        narration: () =>
          Effect.sync(() => {
            narrationCalls++;
            return { file: "narration.mp3" };
          }),
        ...mediaOverrides,
      });
      const layer = StudioService.layer.pipe(
        Layer.provide(
          Layer.mock(StudioAssetFiles.StudioAssetFiles)({
            copy: (input) =>
              Effect.gen(function* () {
                copiedAssets.push(input);
                const file = `studio-import-${copiedAssets.length}/asset.${input.kind === "audio" ? "mp3" : "mp4"}`;
                yield* beforeCopyReturns;
                return {
                  file,
                  discard: Effect.sync(() => {
                    discardedAssets.push(file);
                  }),
                };
              }),
          }),
        ),
        Layer.provideMerge(stores),
        Layer.provide(generation),
        Layer.provide(production),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                projectId: "project",
                worktreePath: id === ThreadId.make("source-thread") ? "/source-workspace" : null,
                deletedAt: null,
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" } as never)),
          }),
        ),
        Layer.provide(
          Layer.mock(MediaService.MediaService)({
            resolveFile: (input) =>
              Effect.succeed({
                kind: input.relativePath.endsWith("png") ? "image" : "video",
              } as never),
            probe: () => Effect.succeed({} as never),
          }),
        ),
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const service = yield* StudioService.StudioService;
        const store = yield* StudioStore.StudioStore;
        const campaigns = yield* CampaignStore.CampaignStore;
        const client = yield* campaigns.upsertClient({
          name: "Cafe",
          brandNotes: "Warm",
          doNotSay: [],
        });
        const campaign = yield* campaigns.upsertCampaign({
          clientId: client.id,
          name: "Morning coffee",
        });
        const blank = yield* service.get(campaign.id);
        const saved = yield* service.run(person, {
          command: "studio.save",
          campaignId: campaign.id,
          expectedRevision: 0,
          brief: {
            ...blank.brief,
            offer: "Coffee",
            sourceThreadId: threadId,
            platforms: ["instagram"],
            durationSeconds: 16,
          },
          scenes: [scene("one"), scene("two")],
        });
        assert.equal(saved.kind, "studio");
        if (saved.kind !== "studio") return;
        yield* work({
          service,
          store,
          campaigns,
          initial: saved.studio,
          jobs,
          requests,
          rendered,
          narrationCalls: () => narrationCalls,
          reservations: paid,
          copiedAssets,
          discardedAssets,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

it.effect("shares durable edits and rejects stale or invalid storyboard writes", () =>
  harness(({ service, initial }) =>
    Effect.gen(function* () {
      const changed = yield* service.run(person, {
        command: "studio.save",
        campaignId: initial.campaignId,
        expectedRevision: initial.revision,
        brief: initial.brief,
        scenes: initial.scenes.map((s) =>
          s.id === "two" ? { ...s, prompt: "New second scene" } : s,
        ),
      });
      assert.equal(changed.kind, "studio");
      const stale = yield* service
        .run(person, {
          command: "studio.save",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision,
          brief: initial.brief,
          scenes: [],
        })
        .pipe(Effect.flip);
      assert.equal(stale.reason, "conflict");
      const fresh = yield* service.get(initial.campaignId);
      assert.equal(fresh.scenes[0]?.prompt, initial.scenes[0]?.prompt);
      assert.equal(fresh.scenes[1]?.prompt, "New second scene");
      const duplicate = yield* service
        .run(person, {
          command: "studio.save",
          campaignId: initial.campaignId,
          expectedRevision: fresh.revision,
          brief: fresh.brief,
          scenes: [scene("same"), scene("same")],
        })
        .pipe(Effect.flip);
      assert.equal(duplicate.reason, "invalid");
    }),
  ),
);
it.effect(
  "agents can prepare work but cannot approve spending or move another conversation's studio",
  () =>
    harness(({ service, initial }) =>
      Effect.gen(function* () {
        const actor = { kind: "agent", threadId } as const;
        for (const command of [
          {
            command: "studio.narrate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            text: "Hello",
            allowanceUsd: 1,
            requestId: "request",
          },
          { command: "studio.render.approve", campaignId: initial.campaignId, renderId: "r" },
          { command: "studio.asset.approve", campaignId: initial.campaignId, assetId: "a" },
        ] as const) {
          const denied = yield* service.run(actor, command).pipe(Effect.flip);
          assert.equal(denied.reason, "not_allowed");
        }
        const denied = yield* service
          .run(
            { kind: "agent", threadId: ThreadId.make("other") },
            {
              command: "studio.save",
              campaignId: initial.campaignId,
              expectedRevision: initial.revision,
              brief: initial.brief,
              scenes: initial.scenes,
            },
          )
          .pipe(Effect.flip);
        assert.equal(denied.reason, "not_allowed");
      }),
    ),
);
it.effect(
  "scene generations require approval and import variants without changing selected footage",
  () =>
    harness(({ service, initial, jobs, requests }) =>
      Effect.gen(function* () {
        yield* service.run(
          { kind: "agent", threadId },
          {
            command: "studio.generate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            sceneIds: ["two"],
          },
        );
        assert.equal(requests.length, 1);
        assert.isTrue(requests[0]?.forceApproval);
        assert.equal(requests[0]?.model, initial.scenes[1]?.model);
        const job = jobs.get("job-1")!;
        jobs.set(job.id, { ...job, status: "done", resultPaths: ["second.mp4"] });
        let state = yield* service.get(initial.campaignId);
        assert.equal(state.assets.length, 1);
        assert.equal(state.assets[0]?.sceneId, "two");
        assert.isNull(state.scenes[1]?.selectedAssetId);
        yield* service.run(person, {
          command: "studio.save",
          campaignId: state.campaignId,
          expectedRevision: state.revision,
          brief: state.brief,
          scenes: state.scenes.map((s) =>
            s.id === "two" ? { ...s, selectedAssetId: state.assets[0]!.id } : s,
          ),
        });
        state = yield* service.get(initial.campaignId);
        yield* service.run(person, {
          command: "studio.generate",
          campaignId: state.campaignId,
          expectedRevision: state.revision,
          sceneIds: ["two"],
        });
        const second = jobs.get("job-2")!;
        jobs.set(second.id, { ...second, status: "done", resultPaths: ["second-v2.mp4"] });
        const next = yield* service.get(initial.campaignId);
        assert.equal(next.assets.length, 2);
        assert.equal(next.scenes[1]?.selectedAssetId, state.assets[0]?.id);
        assert.deepEqual(next.scenes[0], initial.scenes[0]);
        assert.equal((yield* service.get(initial.campaignId)).assets.length, 2);
      }),
    ),
);
it.effect(
  "exports only reviewed render snapshots and preserves them through subsequent scene edits",
  () =>
    harness(({ service, store, campaigns, initial, rendered }) =>
      Effect.gen(function* () {
        let state = initial;
        for (const s of state.scenes) {
          const result = yield* service.run(person, {
            command: "studio.import",
            campaignId: state.campaignId,
            expectedRevision: state.revision,
            file: `${s.id}.mp4`,
            kind: "video",
            sceneId: s.id,
          });
          if (result.kind === "studio") state = result.studio;
        }
        yield* service.run(person, {
          command: "studio.save",
          campaignId: state.campaignId,
          expectedRevision: state.revision,
          brief: state.brief,
          scenes: state.scenes.map((s) => ({
            ...s,
            selectedAssetId: state.assets.find((a) => a.sceneId === s.id)!.id,
          })),
        });
        state = yield* service.get(state.campaignId);
        const subscribed = yield* Deferred.make<void>();
        const completed = yield* campaigns.subscribeChanges.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.mapEffect(() => store.get(state.campaignId)),
          Stream.filter((s) => s.renders.some((r) => r.status === "completed")),
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* service.run(person, {
          command: "studio.render",
          campaignId: state.campaignId,
          expectedRevision: state.revision,
          aspectRatio: "9:16",
        });
        const finished = yield* Fiber.join(completed);
        assert.isTrue(Option.isSome(finished));
        if (Option.isNone(finished)) return;
        const render = finished.value.renders[0]!;
        assert.isFalse(rendered[0]?.keepSourceAudio);
        const postCommand = {
          command: "studio.post",
          campaignId: state.campaignId,
          renderId: render.id,
          platforms: ["instagram"],
          captions: { default: "Fresh coffee", byPlatform: {} },
        } as const;
        assert.equal(
          (yield* service.run(person, postCommand).pipe(Effect.flip)).reason,
          "not_allowed",
        );
        yield* service.run(person, {
          command: "studio.render.approve",
          campaignId: state.campaignId,
          renderId: render.id,
        });
        state = yield* service.get(state.campaignId);
        yield* service.run(person, {
          command: "studio.save",
          campaignId: state.campaignId,
          expectedRevision: state.revision,
          brief: state.brief,
          scenes: state.scenes.map((s) => ({ ...s, prompt: "New creative" })),
        });
        const post = yield* service.run(person, postCommand);
        assert.equal(post.kind, "post");
        if (post.kind === "post") {
          assert.deepEqual(post.post.mediaPaths, [render.file!]);
          assert.equal(post.post.status, "draft");
        }
        assert.equal((yield* service.get(state.campaignId)).renders[0]?.file, render.file);
        assert.equal(
          (yield* service.get(state.campaignId)).renders[0]?.snapshot?.scenes[0]?.prompt,
          initial.scenes[0]?.prompt,
        );
        yield* service.run(person, {
          command: "studio.render.approve",
          campaignId: state.campaignId,
          renderId: render.id,
          approved: false,
        });
        assert.equal(
          (yield* service.run(person, postCommand).pipe(Effect.flip)).reason,
          "not_allowed",
        );
      }),
    ),
);
it.effect("reserves narration once before calling the provider, including a repeated request", () =>
  harness(({ service, initial, narrationCalls }) =>
    Effect.gen(function* () {
      const command = {
        command: "studio.narrate",
        campaignId: initial.campaignId,
        expectedRevision: initial.revision,
        text: "Fresh coffee",
        allowanceUsd: 1,
        requestId: "unique",
      } as const;
      yield* service.run(person, command);
      const state = yield* service.get(initial.campaignId);
      assert.equal(state.assets[0]?.kind, "audio");
      const duplicate = yield* service
        .run(person, { ...command, expectedRevision: state.revision })
        .pipe(Effect.flip);
      assert.equal(duplicate.reason, "conflict");
      assert.equal(narrationCalls(), 1);
    }),
  ),
);

it.effect("omits controls unsupported by each approved model", () =>
  harness(({ service, initial, requests }) =>
    Effect.gen(function* () {
      const saved = yield* service.run(person, {
        command: "studio.save",
        campaignId: initial.campaignId,
        expectedRevision: initial.revision,
        brief: initial.brief,
        scenes: [
          {
            ...scene("one"),
            model: "fal-ai/kling-video/v3/pro/image-to-video",
            referenceImage: "frame.png",
          },
          { ...scene("two"), connector: "muapi", model: "veo3.1-text-to-video" },
        ],
      });
      if (saved.kind !== "studio") return;
      yield* service.run(person, {
        command: "studio.generate",
        campaignId: initial.campaignId,
        expectedRevision: saved.studio.revision,
        sceneIds: ["one", "two"],
      });
      assert.isUndefined(requests[0]?.options?.resolution);
      assert.isUndefined(requests[0]?.options?.aspectRatio);
      assert.equal(requests[0]?.options?.firstFrame, "frame.png");
      assert.isFalse(requests[0]?.options?.generateAudio);
      assert.isUndefined(requests[1]?.options?.generateAudio);
      assert.equal(requests[1]?.options?.aspectRatio, "9:16");
      assert.equal(requests[1]?.options?.resolution, "720p");
    }),
  ),
);

it.effect("only a person can change spending caps while agents can edit creative content", () =>
  harness(({ service, initial }) =>
    Effect.gen(function* () {
      const command = {
        command: "studio.save",
        campaignId: initial.campaignId,
        expectedRevision: initial.revision,
        brief: { ...initial.brief, budgetUsd: 5 },
        scenes: initial.scenes,
      } as const;
      const actor = { kind: "agent", threadId } as const;
      assert.equal((yield* service.run(actor, command).pipe(Effect.flip)).reason, "not_allowed");
      const saved = yield* service.run(person, command);
      if (saved.kind !== "studio") return;
      const edited = yield* service.run(actor, {
        ...command,
        expectedRevision: saved.studio.revision,
        brief: { ...saved.studio.brief, offer: "New offer" },
      });
      assert.equal(edited.kind, "studio");
      assert.equal(
        (yield* service
          .run(actor, {
            ...command,
            expectedRevision: saved.studio.revision + 1,
            brief: { ...initial.brief, budgetUsd: null },
          })
          .pipe(Effect.flip)).reason,
        "not_allowed",
      );
      yield* service.run(person, {
        ...command,
        expectedRevision: saved.studio.revision + 1,
        brief: initial.brief,
      });
      assert.equal((yield* service.get(initial.campaignId)).brief.budgetUsd, 5);
    }),
  ),
);

it.effect("missing narration credentials do not reserve any campaign budget", () =>
  harness(
    ({ service, initial, reservations, narrationCalls }) =>
      Effect.gen(function* () {
        yield* service
          .run(person, {
            command: "studio.narrate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            text: "Hello",
            allowanceUsd: 5,
            requestId: "missing-key",
          })
          .pipe(Effect.flip);
        assert.equal(reservations.size, 0);
        assert.equal(narrationCalls(), 0);
      }),
    {
      checkNarration: () =>
        Effect.fail(
          new StudioMedia.StudioMediaError({
            reason: "not_configured",
          }),
        ),
    },
  ),
);

it.effect("narration in flight allows edits and preserves them when audio arrives", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* harness(
      ({ service, initial }) =>
        Effect.gen(function* () {
          const narration = yield* service
            .run(person, {
              command: "studio.narrate",
              campaignId: initial.campaignId,
              expectedRevision: initial.revision,
              text: "Hello",
              allowanceUsd: 1,
              requestId: "in-flight",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const inFlight = yield* service.get(initial.campaignId);
          yield* service.run(person, {
            command: "studio.save",
            campaignId: initial.campaignId,
            expectedRevision: inFlight.revision,
            brief: { ...initial.brief, offer: "Edited during narration" },
            scenes: initial.scenes,
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(narration);
          const state = yield* service.get(initial.campaignId);
          assert.equal(state.brief.offer, "Edited during narration");
          assert.equal(state.assets[0]?.kind, "audio");
        }),
      {
        narration: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { file: "narration.mp3" };
          }),
      },
    );
  }),
);

it.effect(
  "restart recovery marks interrupted renders failed without changing completed exports",
  () =>
    harness(({ store, initial }) =>
      Effect.gen(function* () {
        const common = {
          revision: initial.revision,
          sourceThreadId: threadId,
          error: null,
          approvedAt: null,
          createdAt: "2026-10-08T00:00:00Z",
          aspectRatio: "9:16" as const,
          sceneAssetIds: [],
        };
        yield* store.modify(initial.campaignId, initial.revision, (s) => ({
          ...s,
          renders: [
            { ...common, id: "interrupted", status: "rendering", file: null },
            {
              ...common,
              id: "finished",
              status: "completed",
              file: "prior.mp4",
              approvedAt: common.createdAt,
            },
          ],
        }));
        yield* store.recoverRenders;
        const recovered = yield* store.get(initial.campaignId);
        assert.equal(recovered.renders[0]?.status, "failed");
        assert.match(recovered.renders[0]?.error ?? "", /restart/);
        assert.equal(recovered.renders[1]?.status, "completed");
        assert.equal(recovered.renders[1]?.file, "prior.mp4");
        assert.equal(recovered.renders[1]?.approvedAt, common.createdAt);
        assert.deepEqual(recovered.scenes, initial.scenes);
        yield* store.recoverRenders;
        assert.equal((yield* store.get(initial.campaignId)).revision, recovered.revision);
      }),
    ),
);

it.effect(
  "failed narration preflight persists immutable approval and retries without duplicate submission",
  () => {
    let configured = false;
    return harness(
      ({ service, initial, reservations, narrationCalls }) =>
        Effect.gen(function* () {
          const command = {
            command: "studio.narrate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            text: "Approved words",
            voiceId: "approved_voice",
            allowanceUsd: 2,
            requestId: "retry-preflight",
          } as const;
          yield* service.run(person, command).pipe(Effect.flip);
          const failed = yield* service.get(initial.campaignId);
          assert.equal(failed.narrations?.[0]?.status, "failed");
          assert.equal(failed.narrations?.[0]?.expenseId, null);
          assert.equal(reservations.size, 0);
          assert.equal(narrationCalls(), 0);
          const changed = yield* service
            .run(person, {
              ...command,
              text: "Changed approval",
              expectedRevision: failed.revision,
            })
            .pipe(Effect.flip);
          assert.equal(changed.reason, "conflict");
          configured = true;
          yield* service.run(person, { ...command, expectedRevision: failed.revision });
          const completed = yield* service.get(initial.campaignId);
          assert.equal(completed.narrations?.[0]?.status, "completed");
          assert.equal(completed.narrations?.[0]?.text, "Approved words");
          assert.equal(completed.narrations?.[0]?.confirmedUsd, null);
          assert.equal(completed.narrations?.[0]?.assetId, completed.assets[0]?.id);
          assert.equal(reservations.size, 1);
          assert.equal(narrationCalls(), 1);
        }),
      {
        checkNarration: () =>
          configured
            ? Effect.void
            : Effect.fail(new StudioMedia.StudioMediaError({ reason: "not_configured" })),
      },
    );
  },
);

it.effect("restart retains uncertain narration and never resubmits its paid request", () =>
  Effect.gen(function* () {
    const submitted = yield* Deferred.make<void>();
    let calls = 0;
    yield* harness(
      ({ service, store, initial, reservations }) =>
        Effect.gen(function* () {
          const command = {
            command: "studio.narrate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            text: "Approved before restart",
            allowanceUsd: 2,
            requestId: "restart-narration",
          } as const;
          const running = yield* service.run(person, command).pipe(Effect.forkChild);
          yield* Deferred.await(submitted);
          assert.equal(
            (yield* store.get(initial.campaignId)).narrations?.[0]?.status,
            "submitting",
          );
          yield* Fiber.interrupt(running);
          assert.equal((yield* store.get(initial.campaignId)).narrations?.[0]?.status, "uncertain");
          // A hard process exit cannot run the interruption finalizer; restore its last durable
          // in-flight state to exercise startup recovery as well.
          yield* store.modify(initial.campaignId, undefined, (s) => ({
            ...s,
            narrations: (s.narrations ?? []).map((n) => ({
              ...n,
              status: "submitting",
              error: null,
            })),
          }));
          yield* store.recoverRenders;
          const recovered = yield* service.get(initial.campaignId);
          assert.equal(recovered.narrations?.[0]?.status, "uncertain");
          assert.equal(recovered.narrations?.[0]?.allowanceUsd, 2);
          assert.equal(recovered.narrations?.[0]?.text, "Approved before restart");
          assert.match(recovered.narrations?.[0]?.error ?? "", /restart/);
          yield* service
            .run(person, { ...command, expectedRevision: recovered.revision })
            .pipe(Effect.flip);
          assert.equal(calls, 1);
          assert.equal(reservations.size, 1);
        }),
      {
        narration: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.succeed(submitted, undefined);
            return yield* Effect.never;
          }),
      },
    );
  }),
);

it.effect("provider errors persist an uncertain narration rather than a retryable failure", () => {
  let calls = 0;
  return harness(
    ({ service, initial, reservations }) =>
      Effect.gen(function* () {
        const command = {
          command: "studio.narrate",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision,
          text: "Ambiguous provider response",
          allowanceUsd: 3,
          requestId: "provider-error",
        } as const;
        yield* service.run(person, command).pipe(Effect.flip);
        const saved = yield* service.get(initial.campaignId);
        assert.equal(saved.narrations?.[0]?.status, "uncertain");
        assert.equal(saved.narrations?.[0]?.confirmedUsd, null);
        assert.equal(reservations.size, 1);
        yield* service
          .run(person, { ...command, expectedRevision: saved.revision })
          .pipe(Effect.flip);
        assert.equal(calls, 1);
      }),
    {
      narration: () =>
        Effect.gen(function* () {
          calls++;
          return yield* new StudioMedia.StudioMediaError({ reason: "provider" });
        }),
    },
  );
});

it.effect(
  "narration reconciliation attaches existing audio without billing or changing approval",
  () =>
    harness(({ service, store, initial, narrationCalls, reservations }) =>
      Effect.gen(function* () {
        const command = {
          command: "studio.narrate",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision,
          text: "Recovered words",
          allowanceUsd: 4,
          requestId: "recovered-narration",
        } as const;
        yield* service.run(person, command);
        const saved = yield* store.get(initial.campaignId);
        yield* store.modify(initial.campaignId, saved.revision, (s) => ({
          ...s,
          narrations: s.narrations?.map((n) => ({
            ...n,
            status: "uncertain",
            assetId: null,
            error: "Interrupted",
          })),
        }));
        const recover = {
          command: "studio.narration.reconcile",
          campaignId: initial.campaignId,
          narrationId: command.requestId,
          assetId: saved.assets[0]!.id,
        } as const;
        const denied = yield* service.run({ kind: "agent", threadId }, recover).pipe(Effect.flip);
        assert.equal(denied.reason, "not_allowed");
        yield* service.run(person, { ...recover, assetId: "missing-audio" }).pipe(Effect.flip);
        yield* service.run(person, recover);
        const completed = yield* service.get(initial.campaignId);
        assert.equal(completed.narrations?.[0]?.status, "completed");
        assert.equal(completed.narrations?.[0]?.assetId, saved.assets[0]!.id);
        assert.equal(completed.narrations?.[0]?.confirmedUsd, null);
        assert.equal(completed.narrations?.[0]?.text, "Recovered words");
        assert.equal(completed.assets[0]?.approved, false);
        assert.equal(narrationCalls(), 1);
        assert.equal(reservations.size, 1);
        yield* service.run(person, recover).pipe(Effect.flip);
        assert.equal(narrationCalls(), 1);
      }),
    ),
);

it.effect(
  "a reservation surviving a crash before its narration status write never submits again",
  () =>
    harness(({ service, initial, reservations, narrationCalls }) =>
      Effect.gen(function* () {
        reservations.add(`studio-narration:${initial.campaignId}:reservation-gap`);
        yield* service
          .run(person, {
            command: "studio.narrate",
            campaignId: initial.campaignId,
            expectedRevision: initial.revision,
            text: "Crash boundary",
            allowanceUsd: 2,
            requestId: "reservation-gap",
          })
          .pipe(Effect.flip);
        const recovered = yield* service.get(initial.campaignId);
        assert.equal(recovered.narrations?.[0]?.status, "uncertain");
        assert.equal(narrationCalls(), 0);
        assert.equal(reservations.size, 1);
      }),
    ),
);

it.effect("rejects an unapproved reuse source before copying any bytes", () =>
  harness(({ service, store, initial, copiedAssets, discardedAssets }) =>
    Effect.gen(function* () {
      const state = yield* store.modify(initial.campaignId, initial.revision, (current) => ({
        ...current,
        assets: [
          {
            id: "unapproved",
            sceneId: null,
            kind: "video",
            file: "original.mp4",
            sourceThreadId: threadId,
            jobId: null,
            prompt: "",
            model: "",
            connector: "upload",
            createdAt: "2026-10-08T00:00:00Z",
            approved: false,
          },
        ],
      }));
      const error = yield* service
        .run(person, {
          command: "studio.asset.reuse",
          campaignId: initial.campaignId,
          expectedRevision: state.revision,
          sourceCampaignId: initial.campaignId,
          assetId: "unapproved",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "not_allowed");
      assert.deepEqual(copiedAssets, []);
      assert.deepEqual(discardedAssets, []);
      assert.deepEqual(yield* store.get(initial.campaignId), state);
    }),
  ),
);

it.effect(
  "copies an approved cross-campaign original with provenance and requires approval again",
  () =>
    harness(({ service, store, campaigns, initial, copiedAssets, discardedAssets }) =>
      Effect.gen(function* () {
        const destination = yield* campaigns.getCampaign(initial.campaignId);
        const sourceCampaign = yield* campaigns.upsertCampaign({
          clientId: destination.clientId,
          name: "Source campaign",
        });
        const original = {
          id: "approved-original",
          sceneId: "original-scene",
          kind: "video" as const,
          file: "original.mp4",
          sourceThreadId: ThreadId.make("source-thread"),
          jobId: "original-job",
          prompt: "Original prompt",
          model: "Original model",
          connector: "fal",
          createdAt: "2026-10-08T00:00:00Z",
          approved: true,
        };
        const source = yield* store.modify(sourceCampaign.id, 0, (current) => ({
          ...current,
          brief: { ...current.brief, sourceThreadId: original.sourceThreadId },
          assets: [original],
        }));
        const result = yield* service.run(person, {
          command: "studio.asset.reuse",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision,
          sourceCampaignId: sourceCampaign.id,
          assetId: original.id,
        });
        assert.equal(result.kind, "studio");
        if (result.kind !== "studio") return;
        assert.deepEqual(copiedAssets, [
          {
            cwd: "/workspace",
            kind: "video",
            source: { cwd: "/source-workspace", file: original.file },
          },
        ]);
        const copied = result.studio.assets[0]!;
        assert.notEqual(copied.id, original.id);
        assert.deepEqual(copied, {
          ...original,
          id: copied.id,
          sceneId: null,
          file: "studio-import-1/asset.mp4",
          sourceThreadId: threadId,
          createdAt: copied.createdAt,
          approved: false,
          provenance: {
            campaignId: sourceCampaign.id,
            assetId: original.id,
            sourceThreadId: original.sourceThreadId,
            file: original.file,
          },
        });
        assert.deepEqual(yield* store.get(sourceCampaign.id), source);
        assert.deepEqual((yield* store.get(initial.campaignId)).assets, [copied]);
        assert.deepEqual(discardedAssets, []);
      }),
    ),
);

it.effect(
  "imports an uploaded attachment into the target workspace and persists an unapproved asset",
  () =>
    harness(({ service, store, initial, copiedAssets, discardedAssets }) =>
      Effect.gen(function* () {
        const attachmentId = "pending-11111111-2222-3333-4444-555555555555-mp4";
        const result = yield* service.run(person, {
          command: "studio.importUploaded",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision,
          attachmentId,
          kind: "video",
        });
        assert.equal(result.kind, "studio");
        if (result.kind !== "studio") return;
        assert.deepEqual(copiedAssets, [
          { cwd: "/workspace", kind: "video", source: { attachmentId } },
        ]);
        const asset = result.studio.assets[0]!;
        assert.equal(asset.file, "studio-import-1/asset.mp4");
        assert.equal(asset.sourceThreadId, threadId);
        assert.equal(asset.approved, false);
        assert.equal(asset.connector, "upload");
        assert.equal(asset.provenance, undefined);
        assert.equal(result.studio.revision, initial.revision + 1);
        assert.deepEqual((yield* store.get(initial.campaignId)).assets, [asset]);
        assert.deepEqual(discardedAssets, []);
      }),
    ),
);

it.effect("rejects stale uploaded imports before making a copy", () =>
  harness(({ service, initial, copiedAssets, discardedAssets }) =>
    Effect.gen(function* () {
      const error = yield* service
        .run(person, {
          command: "studio.importUploaded",
          campaignId: initial.campaignId,
          expectedRevision: initial.revision - 1,
          attachmentId: "pending-upload",
          kind: "audio",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "conflict");
      assert.deepEqual(copiedAssets, []);
      assert.deepEqual(discardedAssets, []);
    }),
  ),
);

it.effect("discards the new copy if a concurrent edit wins CAS while the upload is copying", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* harness(
      ({ service, store, initial, copiedAssets, discardedAssets }) =>
        Effect.gen(function* () {
          const copying = yield* service
            .run(person, {
              command: "studio.importUploaded",
              campaignId: initial.campaignId,
              expectedRevision: initial.revision,
              attachmentId: "pending-upload",
              kind: "audio",
            })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(started);
          const edited = yield* store.modify(initial.campaignId, initial.revision, (current) => ({
            ...current,
            brief: { ...current.brief, offer: "Concurrent edit" },
          }));
          yield* Deferred.succeed(release, undefined);
          const error = yield* Fiber.join(copying);
          assert.equal(error.reason, "conflict");
          assert.equal(copiedAssets.length, 1);
          assert.deepEqual(discardedAssets, ["studio-import-1/asset.mp3"]);
          assert.deepEqual(yield* store.get(initial.campaignId), edited);
        }),
      {},
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
  }),
);
