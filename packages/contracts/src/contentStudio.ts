import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const Money = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const StudioAspectRatio = Schema.Literals(["9:16", "1:1", "16:9"]);
export const StudioBrief = Schema.Struct({
  budgetUsd: Schema.optional(Schema.NullOr(Money)),
  offer: Text(4000),
  audience: Text(2000),
  objective: Text(2000),
  platforms: Schema.Array(Text(40)).check(Schema.isMaxLength(7)),
  references: Schema.Array(Text(2048)).check(Schema.isMaxLength(20)),
  durationSeconds: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 15, maximum: 60 }),
  ),
  sourceThreadId: Schema.NullOr(ThreadId),
});
export type StudioBrief = typeof StudioBrief.Type;
export const StudioScene = Schema.Struct({
  id: Id,
  title: Text(160),
  durationSeconds: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: 1, maximum: 30 }),
  ),
  prompt: Text(8000),
  referenceImage: Schema.NullOr(Text(2048)),
  narration: Text(4000),
  onScreenText: Text(200),
  startSeconds: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  captions: Schema.optional(
    Schema.Array(
      Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Text(200) }),
    ).check(Schema.isMaxLength(200)),
  ),
  selectedAssetId: Schema.NullOr(Id),
  connector: Text(64),
  model: Text(200),
  resolution: Text(40),
  generateAudio: Schema.Boolean,
  allowanceUsd: Schema.NullOr(Money),
});
export type StudioScene = typeof StudioScene.Type;
export const StudioAsset = Schema.Struct({
  id: Id,
  sceneId: Schema.NullOr(Id),
  kind: Schema.Literals(["image", "video", "audio"]),
  file: Text(2048),
  sourceThreadId: ThreadId,
  jobId: Schema.NullOr(Id),
  prompt: Text(8000),
  model: Text(200),
  connector: Text(64),
  createdAt: IsoDateTime,
  approved: Schema.Boolean,
  provenance: Schema.optional(
    Schema.Struct({
      campaignId: Id,
      assetId: Id,
      sourceThreadId: ThreadId,
      file: Text(2048),
    }),
  ),
});
export type StudioAsset = typeof StudioAsset.Type;
export const StudioRender = Schema.Struct({
  id: Id,
  revision: NonNegativeInt,
  status: Schema.Literals(["rendering", "completed", "failed"]),
  file: Schema.NullOr(Text(2048)),
  sourceThreadId: ThreadId,
  error: Schema.NullOr(Text(4000)),
  approvedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  aspectRatio: StudioAspectRatio,
  sceneAssetIds: Schema.Array(Id),
  snapshot: Schema.optional(
    Schema.Struct({
      scenes: Schema.Array(StudioScene),
      fit: Schema.Literals(["crop", "pad"]),
      audioAssetId: Schema.NullOr(Id),
      keepSourceAudio: Schema.Boolean,
    }),
  ),
});
export type StudioRender = typeof StudioRender.Type;
/** An approved narration attempt. A missing billing receipt never means a zero charge. */
export const StudioNarration = Schema.Struct({
  id: Id,
  status: Schema.Literals(["preflight", "submitting", "completed", "failed", "uncertain"]),
  text: Text(5000),
  voiceId: Text(100),
  model: Text(200),
  sourceThreadId: ThreadId,
  allowanceUsd: Money,
  expenseId: Schema.NullOr(Text(200)),
  assetId: Schema.NullOr(Id),
  providerRequestId: Schema.NullOr(Text(200)),
  confirmedUsd: Schema.NullOr(Money),
  error: Schema.NullOr(Text(4000)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type StudioNarration = typeof StudioNarration.Type;
export const StudioBudget = Schema.Struct({
  budgetUsd: Schema.NullOr(Money),
  reservedUsd: Money,
  availableUsd: Schema.NullOr(Money),
  confirmedUsd: Schema.NullOr(Money),
  unreportedCount: NonNegativeInt,
  unresolvedSubmissions: NonNegativeInt,
});
export type StudioBudget = typeof StudioBudget.Type;
export const ContentStudio = Schema.Struct({
  campaignId: Id,
  revision: NonNegativeInt,
  brief: StudioBrief,
  scenes: Schema.Array(StudioScene).check(Schema.isMaxLength(30)),
  assets: Schema.Array(StudioAsset),
  renders: Schema.Array(StudioRender),
  narrations: Schema.optional(Schema.Array(StudioNarration)),
  budget: Schema.optional(StudioBudget),
  generationLinks: Schema.Array(Schema.Struct({ sceneId: Id, jobId: Id })),
});
export type ContentStudio = typeof ContentStudio.Type;
const version = { campaignId: Id, expectedRevision: NonNegativeInt };
export const StudioSaveInput = Schema.Struct({
  ...version,
  brief: StudioBrief,
  scenes: Schema.Array(StudioScene).check(Schema.isMaxLength(30)),
});
export const StudioCommand = Schema.Union([
  Schema.Struct({ command: Schema.Literal("studio.save"), ...StudioSaveInput.fields }),
  Schema.Struct({
    command: Schema.Literal("studio.import"),
    ...version,
    file: Text(2048),
    kind: StudioAsset.fields.kind,
    sceneId: Schema.optional(Id),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.importUploaded"),
    ...version,
    attachmentId: Text(256),
    kind: StudioAsset.fields.kind,
  }),
  Schema.Struct({
    command: Schema.Literal("studio.asset.reuse"),
    ...version,
    sourceCampaignId: Id,
    assetId: Id,
  }),
  Schema.Struct({
    command: Schema.Literal("studio.asset.approve"),
    campaignId: Id,
    assetId: Id,
    approved: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.generate"),
    ...version,
    sceneIds: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.render"),
    ...version,
    aspectRatio: StudioAspectRatio,
    fit: Schema.optional(Schema.Literals(["crop", "pad"])),
    audioAssetId: Schema.optional(Id),
    keepSourceAudio: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.render.approve"),
    campaignId: Id,
    renderId: Id,
    approved: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.post"),
    campaignId: Id,
    renderId: Id,
    platforms: Schema.Array(Text(40)),
    captions: Schema.Struct({
      default: Text(10000),
      byPlatform: Schema.Record(Schema.String, Text(10000)),
    }),
    scheduledAt: Schema.optional(IsoDateTime),
  }),
  Schema.Struct({
    command: Schema.Literal("studio.narration.reconcile"),
    campaignId: Id,
    narrationId: Id,
    assetId: Id,
  }),
  Schema.Struct({
    command: Schema.Literal("studio.narrate"),
    ...version,
    text: Text(5000),
    voiceId: Schema.optional(Text(100)),
    allowanceUsd: Money,
    requestId: Id,
  }),
]);
export type StudioCommand = typeof StudioCommand.Type;
