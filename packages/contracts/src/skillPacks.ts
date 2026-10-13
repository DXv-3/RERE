import * as Schema from "effect/Schema";

/** The packs the client can name. A client never sends a URL; it sends one of these ids. */
export const SkillPackId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
export type SkillPackId = typeof SkillPackId.Type;

export const SkillPackInput = Schema.Struct({ packId: SkillPackId });
export type SkillPackInput = typeof SkillPackInput.Type;

/**
 * Listing, installing (or updating) and removing share one call: the RPC group is at the size
 * TypeScript can still check. The answer is always a list: every pack for "list", the one changed
 * pack otherwise.
 */
export const SkillPackRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  // Saves the built-in starter skills, turned off. Rides on this call for the same size reason.
  Schema.Struct({ action: Schema.Literal("admit-starters") }),
  Schema.Struct({ action: Schema.Literals(["install", "remove"]), packId: SkillPackId }),
]);
export type SkillPackRequest = typeof SkillPackRequest.Type;

export const SkillPackSourceSummary = Schema.Struct({
  id: Schema.String,
  repositoryUrl: Schema.String,
  /** The pinned commit this build downloads. */
  commit: Schema.String,
  license: Schema.String,
  /** The commit on disk, or null when this source is not installed. */
  installedCommit: Schema.NullOr(Schema.String),
});
export type SkillPackSourceSummary = typeof SkillPackSourceSummary.Type;

export const SkillPackSummary = Schema.Struct({
  id: SkillPackId,
  title: Schema.String,
  description: Schema.String,
  sources: Schema.Array(SkillPackSourceSummary),
  installed: Schema.Boolean,
  /** Skills on disk when installed, else the number the pack lists; null when it does not say. */
  skillCount: Schema.NullOr(Schema.Number),
  /** Installed, but this build pins a different commit for at least one source. */
  updateAvailable: Schema.Boolean,
});
export type SkillPackSummary = typeof SkillPackSummary.Type;

export class SkillPackError extends Schema.TaggedError<SkillPackError>()("SkillPackError", {
  reason: Schema.Literals([
    "unknown_pack",
    "git_missing",
    "download_failed",
    "too_large",
    "no_skills",
    "index_failed",
    "storage",
  ]),
}) {
  override get message() {
    return `Skill pack: ${this.reason}.`;
  }
}
