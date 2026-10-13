import type { ProviderInstanceConfig } from "@t3tools/contracts";
import type { RelayModelShareInviteOffer } from "@t3tools/contracts/relay";
import { readCustomModelEntries } from "@t3tools/shared/model";

import { formatModelShareCode } from "./modelShareCode";

/**
 * Decides what to do with the model shares other people offered to this account's email: which to
 * add, which this computer already has, and which to leave alone. It is pure so the rules can be
 * tested without a relay or a settings store. Adding goes through the same path as a pasted share
 * code, so each addition carries the code `formatModelShareCode` builds.
 */

export interface PlannedInviteAddition {
  readonly invite: RelayModelShareInviteOffer;
  /** The same `codewrench-share:` text the owner could have sent by hand. */
  readonly code: string;
}

export interface SharedModelInvitePlan {
  /** New to this computer: add each, then tell the relay. */
  readonly add: ReadonlyArray<PlannedInviteAddition>;
  /** Already set up here (or repeated in the list): no need to add, just tell the relay. */
  readonly alreadyHave: ReadonlyArray<RelayModelShareInviteOffer>;
  /** Not safe or not readable: leave them waiting and add nothing. */
  readonly skipped: ReadonlyArray<RelayModelShareInviteOffer>;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** One share, as far as can be told without its token: where it points and what it serves. */
function shareKey(baseUrl: string, models: ReadonlyArray<string>): string {
  return `${normalizeBaseUrl(baseUrl)}\u0000${[...models].toSorted().join("\u0000")}`;
}

function existingShareKeys(
  instances: Readonly<Record<string, ProviderInstanceConfig | undefined>> | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const instance of Object.values(instances ?? {})) {
    if (!instance || instance.driver !== "claudeAgent") continue;
    const baseUrl = instance.environment?.find(
      (variable) => variable.name === "ANTHROPIC_BASE_URL",
    )?.value;
    if (!baseUrl) continue;
    const config: unknown = instance.config;
    const customModels =
      typeof config === "object" && config !== null
        ? (config as Record<string, unknown>).customModels
        : undefined;
    const models = readCustomModelEntries(customModels).map((model) => model.slug);
    if (models.length > 0) keys.add(shareKey(baseUrl, models));
  }
  return keys;
}

export function planSharedModelInvites(input: {
  readonly invites: ReadonlyArray<RelayModelShareInviteOffer>;
  readonly existingInstances:
    | Readonly<Record<string, ProviderInstanceConfig | undefined>>
    | undefined;
}): SharedModelInvitePlan {
  const seenKeys = new Set(existingShareKeys(input.existingInstances));
  const seenInviteIds = new Set<string>();
  const add: Array<PlannedInviteAddition> = [];
  const alreadyHave: Array<RelayModelShareInviteOffer> = [];
  const skipped: Array<RelayModelShareInviteOffer> = [];

  for (const invite of input.invites) {
    if (seenInviteIds.has(invite.inviteId)) {
      alreadyHave.push(invite);
      continue;
    }
    seenInviteIds.add(invite.inviteId);

    // A token must never be sent over a plain-text address, whatever the relay says.
    if (!isHttps(invite.baseUrl)) {
      skipped.push(invite);
      continue;
    }
    let code: string;
    try {
      code = formatModelShareCode({
        baseUrl: invite.baseUrl,
        token: invite.token,
        models: invite.models,
      });
    } catch {
      skipped.push(invite);
      continue;
    }
    const key = shareKey(invite.baseUrl, invite.models);
    if (seenKeys.has(key)) {
      alreadyHave.push(invite);
      continue;
    }
    seenKeys.add(key);
    add.push({ invite, code });
  }
  return { add, alreadyHave, skipped };
}

/** The one notice after collecting, or null when nothing was added. Never includes a token. */
export function describeCollectedSharedModels(
  collected: ReadonlyArray<{
    readonly label: string;
    readonly models: ReadonlyArray<string>;
  }>,
): string | null {
  const [first] = collected;
  if (!first) return null;
  const modelCount = collected.reduce((total, entry) => total + entry.models.length, 0);
  if (collected.length === 1 && modelCount === 1) {
    return `${first.label} shared ${first.models[0]} with you. It is in your model list.`;
  }
  if (collected.length === 1) {
    return `${first.label} shared ${modelCount} models with you. They are in your model list.`;
  }
  return `${collected.length} people shared models with you. They are in your model list.`;
}
