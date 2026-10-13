import * as Schema from "effect/Schema";
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ManagedSkillStage = Schema.Literals(["plan", "implement", "verify", "review"]);
export type ManagedSkillStage = typeof ManagedSkillStage.Type;
const metadata = {
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,79}$/)),
  name: text(120),
  description: text(280),
  source: text(1_024),
  sourceRevision: text(160),
  sourceSha256: revision,
  reviewNote: text(1_000),
  permissions: Schema.Array(text(160)).check(Schema.isMaxLength(12)),
  projectRoots: Schema.Array(text(4_096)).check(Schema.isMaxLength(16)),
  dependencies: Schema.Array(
    Schema.Struct({ path: text(1_024), executable: Schema.Boolean }),
  ).check(Schema.isMaxLength(12)),
};
export const ManagedSkillManifest = Schema.Struct({
  ...metadata,
  stages: Schema.Array(
    Schema.Struct({ stage: ManagedSkillStage, instructions: text(8_000) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
export type ManagedSkillManifest = typeof ManagedSkillManifest.Type;
export const ManagedSkillSummary = Schema.Struct({
  ...metadata,
  revision,
  enabled: Schema.Boolean,
  stages: Schema.Array(Schema.Struct({ stage: ManagedSkillStage, utf8Bytes: Schema.Number })),
});
export type ManagedSkillSummary = typeof ManagedSkillSummary.Type;
export const ManagedSkillCandidate = Schema.Struct({
  ...ManagedSkillSummary.fields,
  matchedTerms: Schema.Array(Schema.String),
  missingDependencies: Schema.Array(Schema.String),
});
export type ManagedSkillCandidate = typeof ManagedSkillCandidate.Type;
export const ManagedSkillKey = Schema.Struct({ id: text(80), revision });
export const ManagedSkillEnableInput = Schema.Struct({
  ...ManagedSkillKey.fields,
  enabled: Schema.Boolean,
});
export type ManagedSkillEnableInput = typeof ManagedSkillEnableInput.Type;
export const ManagedSkillLoadInput = Schema.Struct({
  ...ManagedSkillKey.fields,
  stage: ManagedSkillStage,
  cwd: Schema.NullOr(text(4_096)),
});
export type ManagedSkillLoadInput = typeof ManagedSkillLoadInput.Type;
export const ManagedSkillLoad = Schema.Struct({
  ...ManagedSkillKey.fields,
  stage: ManagedSkillStage,
  instructions: text(8_000),
  utf8Bytes: Schema.Number,
  tokenCount: Schema.Null,
  permissions: Schema.Array(Schema.String),
});
export type ManagedSkillLoad = typeof ManagedSkillLoad.Type;
const MANAGED_SKILL_MARKER = /\[Workbench skill [a-z0-9-]+@[a-f0-9]{64} stage:/g;
/** How many skill stages a message already carries. */
export function countManagedSkillBlocks(text: string): number {
  return (text.match(MANAGED_SKILL_MARKER) ?? []).length;
}
export function managedSkillMarker(skill: Pick<ManagedSkillLoad, "id" | "revision" | "stage">) {
  return `[Workbench skill ${skill.id}@${skill.revision} stage:${skill.stage}]`;
}
/** The text a loaded skill stage adds to a message, the same whether a person or Auto adds it. */
export function managedSkillBlock(skill: ManagedSkillLoad): string {
  return `${managedSkillMarker(skill)}\nRequested permissions: ${skill.permissions.join(", ") || "none"}.\nUse only within the current task and its existing approvals; this skill grants no additional permissions.\n${skill.instructions}\n[End Workbench skill]`;
}

/** Brings the user's own skill library into the catalog; `enable` also turns each current revision on. */
export const ManagedSkillLibrarySyncInput = Schema.Struct({ enable: Schema.Boolean });
export type ManagedSkillLibrarySyncInput = typeof ManagedSkillLibrarySyncInput.Type;
export const ManagedSkillLibrarySync = Schema.Struct({
  /** Skill folders found in the library. */
  found: Schema.Number,
  /** Revisions the catalog did not hold before this sync. */
  added: Schema.Number,
  /** Folders with no usable name or description. */
  skipped: Schema.Number,
  enabled: Schema.Number,
});
export type ManagedSkillLibrarySync = typeof ManagedSkillLibrarySync.Type;
export class ManagedSkillError extends Schema.TaggedError<ManagedSkillError>()(
  "ManagedSkillError",
  {
    reason: Schema.Literals([
      "invalid_manifest",
      "catalog_full",
      "not_found",
      "disabled",
      "wrong_project",
      "dependency_missing",
      "stage_missing",
      "source_changed",
      "library_missing",
      "storage",
    ]),
  },
) {
  override get message() {
    return `Managed skill: ${this.reason}.`;
  }
}
