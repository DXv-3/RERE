import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Where a share's holder points `ANTHROPIC_BASE_URL`, relative to the environment's address. */
export const MODEL_SHARE_ROUTE_PREFIX = "/api/model-share";

/** One person's access to the models a provider serves. Never carries the token. */
export const ModelShare = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  models: Schema.Array(TrimmedNonEmptyString),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** Set when the share was made for an email address and so also waits in that person's account. */
  recipientEmail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** When that person's CodeWrench collected it; null while it is still waiting. */
  inviteAcceptedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ModelShare = typeof ModelShare.Type;

/** A provider whose models can be shared: a Claude provider on its own endpoint. */
export const ShareableModelProvider = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  models: Schema.Array(TrimmedNonEmptyString),
});
export type ShareableModelProvider = typeof ShareableModelProvider.Type;

export const ModelShareSnapshot = Schema.Struct({
  shares: Schema.Array(ModelShare),
  providers: Schema.Array(ShareableModelProvider),
});
export type ModelShareSnapshot = typeof ModelShareSnapshot.Type;

export const ModelShareCreateInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  /** Also offer the share to the CodeWrench account with this email. Needs this machine signed in. */
  recipientEmail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ModelShareCreateInput = typeof ModelShareCreateInput.Type;

/** The token is returned by creation alone. */
export const ModelShareCreateResult = Schema.Struct({
  share: ModelShare,
  token: TrimmedNonEmptyString,
  /** True when the relay emailed the recipient about the invitation. Absent when it did not. */
  emailed: Schema.optionalKey(Schema.Boolean),
});
export type ModelShareCreateResult = typeof ModelShareCreateResult.Type;

export const ModelShareRevokeInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type ModelShareRevokeInput = typeof ModelShareRevokeInput.Type;

export const ModelShareRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type ModelShareRevokeResult = typeof ModelShareRevokeResult.Type;
