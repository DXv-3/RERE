import { CAMPAIGN_PLATFORMS, CampaignError, ContentStudio } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CampaignStore from "../CampaignStore.ts";

const Json = Schema.fromJsonString(ContentStudio);
const encode = Schema.encodeSync(Json);
const decodeStudio = Schema.decodeEffect(ContentStudio);
const isCampaignError = Schema.is(CampaignError);
const decode = Schema.decodeUnknownSync(Json);
const failure = (reason: CampaignError["reason"], message: string) =>
  new CampaignError({ reason, message });

export function emptyStudio(campaignId: string): ContentStudio {
  return {
    campaignId,
    revision: 0,
    brief: {
      offer: "",
      audience: "",
      objective: "",
      platforms: [],
      references: [],
      durationSeconds: 30,
      sourceThreadId: null,
    },
    scenes: [],
    assets: [],
    renders: [],
    generationLinks: [],
  };
}

function validateStudio(state: ContentStudio): string | null {
  const ids = state.scenes.map((s) => s.id);
  if (new Set(ids).size !== ids.length) return "Every scene needs its own ID.";
  if (state.brief.platforms.some((p) => !(CAMPAIGN_PLATFORMS as readonly string[]).includes(p)))
    return "Choose supported social platforms.";
  for (const scene of state.scenes) {
    if (scene.selectedAssetId !== null) {
      const asset = state.assets.find((a) => a.id === scene.selectedAssetId);
      if (!asset || asset.kind !== "video")
        return "Select a video variant from this campaign's library.";
      if (asset.sourceThreadId !== state.brief.sourceThreadId)
        return "The selected video belongs to a different workspace thread.";
    }
  }
  return null;
}

export class StudioStore extends Context.Service<
  StudioStore,
  {
    readonly get: (campaignId: string) => Effect.Effect<ContentStudio, CampaignError>;
    readonly modify: (
      campaignId: string,
      expectedRevision: number | undefined,
      change: (current: ContentStudio) => ContentStudio,
    ) => Effect.Effect<ContentStudio, CampaignError>;
    readonly recoverRenders: Effect.Effect<void, CampaignError>;
  }
>()("t3/campaigns/studio/StudioStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const campaigns = yield* CampaignStore.CampaignStore;
  const lock = yield* Semaphore.make(1);
  const mapError = (e: unknown) =>
    isCampaignError(e) ? e : failure("storage", "Could not save the content studio. Try again.");
  const get = (campaignId: string) =>
    Effect.gen(function* () {
      yield* campaigns.getCampaign(campaignId);
      const rows = yield* sql<{
        document: string;
      }>`SELECT document FROM workbench_content_studios WHERE campaign_id=${campaignId}`;
      return rows[0]
        ? yield* Effect.try({ try: () => decode(rows[0]!.document), catch: mapError })
        : emptyStudio(campaignId);
    }).pipe(Effect.mapError(mapError));
  const modify: StudioStore["Service"]["modify"] = (campaignId, expectedRevision, change) =>
    lock.withPermits(1)(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const previous = yield* get(campaignId);
            if (expectedRevision !== undefined && previous.revision !== expectedRevision)
              return yield* failure(
                "conflict",
                "This campaign changed in another view. Refresh before saving your changes.",
              );
            const next = yield* decodeStudio({
              ...change(previous),
              campaignId,
              revision: previous.revision + 1,
            }).pipe(Effect.mapError(mapError));
            const problem = validateStudio(next);
            if (problem) return yield* failure("invalid", problem);
            yield* sql`INSERT INTO workbench_content_studios (campaign_id,revision,document) VALUES (${campaignId},${next.revision},${encode(next)}) ON CONFLICT(campaign_id) DO UPDATE SET revision=excluded.revision,document=excluded.document`;
            return next;
          }),
        )
        .pipe(
          Effect.mapError(mapError),
          Effect.tap(() => campaigns.touch),
        ),
    );
  const recoverRenders = Effect.gen(function* () {
    const rows = yield* sql<{
      campaign_id: string;
      document: string;
    }>`SELECT campaign_id,document FROM workbench_content_studios`;
    for (const row of rows) {
      const state = yield* Effect.try({ try: () => decode(row.document), catch: mapError });
      if (
        state.renders.some((r) => r.status === "rendering") ||
        state.narrations?.some((n) => n.status === "preflight" || n.status === "submitting")
      )
        yield* modify(row.campaign_id, undefined, (s) => ({
          ...s,
          narrations: (s.narrations ?? []).map((n) =>
            n.status === "preflight" || n.status === "submitting"
              ? {
                  ...n,
                  status: n.status === "preflight" ? "failed" : "uncertain",
                  error:
                    n.status === "preflight"
                      ? "Preflight was interrupted by a restart. No provider request was submitted; retry is safe."
                      : "Submission was interrupted by a restart. Check ElevenLabs history before any new paid request; this attempt will not be resubmitted.",
                }
              : n,
          ),
          renders: s.renders.map((r) =>
            r.status === "rendering"
              ? {
                  ...r,
                  status: "failed",
                  error:
                    "Rendering was interrupted by a restart. Your source clips are unchanged; render again.",
                }
              : r,
          ),
        }));
    }
  }).pipe(Effect.mapError(mapError));
  return StudioStore.of({ get, modify, recoverRenders });
});
export const layer = Layer.effect(StudioStore, make);
