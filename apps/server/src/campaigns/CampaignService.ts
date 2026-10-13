import {
  AuthAccessWriteScope,
  StudioCommand,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type CampaignBoard,
  type CampaignCommand,
  type CampaignCommandResult,
  type CampaignError,
  type CampaignPost,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as StudioService from "./studio/StudioService.ts";

import * as CampaignConnection from "./CampaignConnection.ts";
import * as CampaignPublisher from "./CampaignPublisher.ts";
import * as CampaignStore from "./CampaignStore.ts";
import * as CampaignStorage from "./storage/CampaignStorage.ts";
import * as GenerationService from "./generation/GenerationService.ts";

/**
 * The scope a command needs. Saving or submitting a post is ordinary work and needs only the
 * operate scope. Everything else approves, publishes, deletes or changes a mode or the connection,
 * and needs the owner's access scope: a standard client can write drafts but cannot send anything.
 * That includes every `generation.*` command: starting a generation spends the owner's money.
 */
const isStudioCommand = Schema.is(StudioCommand);

export const commandScope = (command: CampaignCommand): AuthEnvironmentScope =>
  command.command === "post.save" ||
  command.command === "post.submit" ||
  (isStudioCommand(command) &&
    !StudioService.studioCommandNeedsApproval(command) &&
    !(command.command === "studio.save" && command.brief.budgetUsd !== undefined))
    ? AuthOrchestrationOperateScope
    : AuthAccessWriteScope;

/**
 * What a person does with campaigns, as one service for the transport: the board they watch, the
 * edits they make and the commands only the owner may give. Agents never come through here; their
 * tools use the store directly, as an agent actor that the rules refuse to approve anything.
 */
export class CampaignService extends Context.Service<
  CampaignService,
  {
    /** The board on subscribe and again after every change. */
    readonly subscribeBoard: (campaignId?: string) => Stream.Stream<CampaignBoard, CampaignError>;
    /** Runs one owner command. Publishing now and retrying also ask the publisher to look at once. */
    readonly run: (command: CampaignCommand) => Effect.Effect<CampaignCommandResult, CampaignError>;
  }
>()("t3/campaigns/CampaignService") {}

const make = Effect.gen(function* () {
  const store = yield* CampaignStore.CampaignStore;
  const connection = yield* CampaignConnection.CampaignConnection;
  const publisher = yield* CampaignPublisher.CampaignPublisher;
  const storage = yield* CampaignStorage.CampaignStorage;
  const generation = yield* GenerationService.GenerationService;
  const studio = yield* StudioService.StudioService;

  const board = (revision: number, campaignId: string | undefined) =>
    Effect.gen(function* () {
      const [clients, campaigns, state, storageState, shown, generated, contentStudio] =
        yield* Effect.all([
          store.listClients,
          store.listCampaigns(),
          connection.get,
          storage.get,
          campaignId === undefined
            ? Effect.succeed({ posts: [], log: [] })
            : store.listPostsWithLog(campaignId),
          generation.board(campaignId),
          campaignId === undefined ? Effect.succeed(null) : studio.get(campaignId),
        ]);
      return {
        revision,
        clients,
        campaigns,
        connection: state,
        storage: storageState,
        posts: shown.posts,
        log: shown.log,
        generation: generated,
        studio: contentStudio,
      } satisfies CampaignBoard;
    });

  const subscribeBoard: CampaignService["Service"]["subscribeBoard"] = (campaignId) =>
    store.subscribeChanges.pipe(Stream.mapEffect((revision) => board(revision, campaignId)));

  const run: CampaignService["Service"]["run"] = (command) => {
    if (isStudioCommand(command)) return studio.run({ kind: "person" }, command);
    const post = (effect: Effect.Effect<CampaignPost, CampaignError>) =>
      effect.pipe(Effect.map((value) => ({ kind: "post", post: value }) as const));
    const lookNow = Effect.forkDetach(publisher.tick);
    switch (command.command) {
      case "client.upsert":
        return store
          .upsertClient(command.client)
          .pipe(Effect.map((client) => ({ kind: "client", client }) as const));
      case "client.delete":
        return store
          .deleteClient(command.id)
          .pipe(Effect.as({ kind: "deleted", id: command.id } as const));
      case "campaign.upsert":
        return store
          .upsertCampaign(command.campaign)
          .pipe(Effect.map((campaign) => ({ kind: "campaign", campaign }) as const));
      case "campaign.delete":
        return store
          .deleteCampaign(command.id)
          .pipe(Effect.as({ kind: "deleted", id: command.id } as const));
      case "post.save":
        return post(store.savePost({ kind: "person" }, command.post));
      case "post.submit":
        return post(store.submitPost({ kind: "person" }, command.postId));
      case "post.approve":
        return post(
          store.approvePost({ postId: command.postId, scheduledAt: command.scheduledAt }),
        );
      case "post.requestChanges":
        return post(store.requestChanges({ postId: command.postId, text: command.text }));
      case "post.reject":
        return post(store.rejectPost(command.postId));
      case "post.publishNow":
        return post(store.publishNow(command.postId).pipe(Effect.tap(() => lookNow)));
      case "post.retry":
        return post(store.retryPost(command.postId).pipe(Effect.tap(() => lookNow)));
      case "post.delete":
        return store
          .deletePost(command.postId)
          .pipe(Effect.as({ kind: "deleted", id: command.postId } as const));
      case "connection.set":
        return connection.set(command.connection).pipe(
          Effect.tap(() => store.touch),
          Effect.map((state) => ({ kind: "connection", connection: state }) as const),
        );
      case "connection.test":
        return connection
          .test(command.connector)
          .pipe(Effect.map((result) => ({ kind: "connectionTest", result }) as const));
      case "storage.set":
        return storage.set(command.storage).pipe(
          Effect.tap(() => store.touch),
          Effect.map((state) => ({ kind: "storage", storage: state }) as const),
        );
      case "storage.test":
        return storage.test.pipe(
          Effect.map((result) => ({ kind: "storageTest", result }) as const),
        );
      case "post.uploadMedia":
        return post(storage.uploadPostMedia(command.postId));
      case "post.revokeMedia":
        return post(storage.revokePostMedia(command.postId));
      case "generation.reconcile":
        return generation
          .reconcileJob(command)
          .pipe(Effect.map((job) => ({ kind: "generationJob", job }) as const));
      case "generation.start": {
        const { command: _command, ...input } = command;
        return generation
          .startJob({ ...input, actor: { kind: "person" } })
          .pipe(Effect.map((job) => ({ kind: "generationJob", job }) as const));
      }
      case "generation.approve":
      case "generation.cancel":
        return (
          command.command === "generation.approve"
            ? generation.approveJob(command.jobId)
            : generation.cancelJob(command.jobId)
        ).pipe(Effect.map((job) => ({ kind: "generationJob", job }) as const));
      case "generation.settings.set":
        return generation
          .setSettings(command.settings)
          .pipe(Effect.map((settings) => ({ kind: "generationSettings", settings }) as const));
      case "generation.test":
        return generation.test(command.generator, command.action).pipe(
          Effect.map(
            (result) =>
              ({
                kind: "connectionTest",
                result: {
                  ok: result.ok,
                  ...(result.ok ? {} : { reason: result.reason ?? "" }),
                  ...(result.notes === undefined ? {} : { notes: result.notes }),
                },
              }) as const,
          ),
        );
    }
  };

  return CampaignService.of({ subscribeBoard, run });
});

export const layer = Layer.effect(CampaignService, make);
