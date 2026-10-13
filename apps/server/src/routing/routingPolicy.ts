import * as DateTime from "effect/DateTime";
import { explicitSkillNames } from "../skills/explicitSkillNames.ts";
import type {
  RoutingAccountReason,
  RoutingPreview,
  RoutingPreviewInput,
  ServerProvider,
} from "@t3tools/contracts";

// Reasons that make a provider unusable right now, as opposed to merely unmeasured.
export const BLOCKED = new Set([
  "disabled",
  "unavailable",
  "sign_in_required",
  "no_models",
  "quota_reserved",
]);

const MAX_QUOTA_AGE_MS = 5 * 60_000;
const RESERVE_PERCENT = 10;

// Credential homes and provider profile IDs are stronger than a display label.
// Never expose these keys in a client recommendation.
function identityKeys(provider: ServerProvider): string[] {
  const keys: string[] = [];
  const prefix = provider.driver;
  if (provider.usageLimits?.credentialFingerprint)
    keys.push(`${prefix}:credential:${provider.usageLimits.credentialFingerprint}`);
  if (provider.auth.profileId) keys.push(`${prefix}:profile:${provider.auth.profileId}`);
  if (provider.auth.email) keys.push(`${prefix}:email:${provider.auth.email.trim().toLowerCase()}`);
  return keys;
}

function accountStatus(provider: ServerProvider, now: number) {
  const limits = provider.usageLimits;
  const windows = limits?.windows ?? [];
  const remainingPercent = windows.length
    ? Math.max(0, Math.min(...windows.map((window) => 100 - window.usedPercent)))
    : null;
  const quotaCheckedAt = limits ? limits.checkedAt : null;
  let reason: RoutingAccountReason = "available";
  if (!provider.enabled) reason = "disabled";
  else if (
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.status !== "ready"
  )
    reason = "unavailable";
  else if (provider.auth.status !== "authenticated") reason = "sign_in_required";
  else if (identityKeys(provider).length === 0) reason = "identity_unknown";
  else if (provider.models.length === 0) reason = "no_models";
  else if (limits?.unavailable?.reason === "probeFailed") reason = "quota_failed";
  else if (!limits || limits.unavailable || remainingPercent === null) reason = "quota_unknown";
  else if (
    !Number.isFinite(Date.parse(limits.checkedAt)) ||
    now - Date.parse(limits.checkedAt) > MAX_QUOTA_AGE_MS ||
    Date.parse(limits.checkedAt) > now ||
    windows.some(
      (window) =>
        window.resetsAt &&
        (!Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) <= now),
    )
  )
    reason = "quota_stale";
  else if (remainingPercent <= RESERVE_PERCENT) reason = "quota_reserved";
  return {
    instanceId: provider.instanceId,
    name: provider.displayName ?? provider.instanceId,
    reason: reason as RoutingAccountReason,
    remainingPercent,
    quotaCheckedAt,
    sharedWith: null as ServerProvider["instanceId"] | null,
  };
}

const STOP_WORDS = new Set(
  "a an the to for with from this that and or of in on is it be we i you our my please use make build create help want need can how some all task work using into".split(
    " ",
  ),
);
function words(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
        .map((word) => (word.endsWith("s") ? word.slice(0, -1) : word))
        .filter((word) => !STOP_WORDS.has(word)),
    ),
  ];
}

export function previewRouting(
  providers: ReadonlyArray<ServerProvider>,
  input: RoutingPreviewInput,
  now: number,
): RoutingPreview {
  const accounts = providers.map((provider) => accountStatus(provider, now));
  // Connected components cover aliases that share either a fingerprint or profile.
  const groups: Array<{ keys: Set<string>; indexes: number[] }> = [];
  providers.forEach((provider, index) => {
    const keys = identityKeys(provider);
    if (!keys.length) return;
    const matches = groups.filter((group) => keys.some((key) => group.keys.has(key)));
    const merged = { keys: new Set(keys), indexes: [index] };
    for (const group of matches) {
      group.keys.forEach((key) => merged.keys.add(key));
      merged.indexes.push(...group.indexes);
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push(merged);
  });
  for (const group of groups) {
    if (group.indexes.length < 2) continue;
    const relevant = group.indexes.filter((index) => providers[index]!.enabled);
    // Conflicting quota reports cannot create an extra allowance through an alias.
    const blocker = relevant
      .map((index) => accounts[index]!)
      .find((account) =>
        ["quota_failed", "quota_unknown", "quota_stale", "quota_reserved"].includes(account.reason),
      );
    const groupRemaining = Math.min(
      ...relevant.flatMap((index) =>
        accounts[index]!.remainingPercent === null ? [] : [accounts[index]!.remainingPercent!],
      ),
    );
    const canonical =
      relevant.find(
        (index) =>
          accounts[index]!.reason === "available" &&
          accounts[index]!.instanceId === input.instanceId,
      ) ??
      relevant
        .filter((index) => accounts[index]!.reason === "available")
        .sort((a, b) => accounts[a]!.instanceId.localeCompare(accounts[b]!.instanceId))[0] ??
      group.indexes[0]!;
    for (const index of group.indexes) {
      const account = accounts[index]!;
      if (account.reason !== "available") continue;
      if (Number.isFinite(groupRemaining)) account.remainingPercent = groupRemaining;
      if (blocker) {
        account.reason = blocker.reason;
        account.remainingPercent = blocker.remainingPercent;
      } else if (index !== canonical) {
        account.reason = "shared_account";
        account.sharedWith = accounts[canonical]!.instanceId;
      }
    }
  }
  const recommended = accounts
    .filter((account) => account.reason === "available")
    .sort(
      (a, b) =>
        (b.remainingPercent ?? 0) - (a.remainingPercent ?? 0) ||
        Number(b.instanceId === input.instanceId) - Number(a.instanceId === input.instanceId) ||
        a.instanceId.localeCompare(b.instanceId),
    )[0];
  const provider = providers.find((item) => item.instanceId === input.instanceId && item.enabled);
  const workspace = input.cwd
    ? provider?.workspaceSnapshots?.find((item) => item.cwd === input.cwd)
    : null;
  // A missing project snapshot must not borrow skills discovered in another project.
  const catalog = input.cwd ? workspace?.skills : provider?.skills;
  const terms = words(input.task);
  const references = explicitSkillNames(input.task);
  const names = new Set<string>();
  const skills = (catalog ?? [])
    .slice(0, 4_096)
    .filter((skill) => {
      if (
        !skill.enabled ||
        (skill.userInvocationOnly && !references.has(skill.name.toLowerCase())) ||
        names.has(skill.name)
      )
        return false;
      names.add(skill.name);
      return true;
    })
    .map((skill) => {
      const description = skill.description ?? skill.shortDescription ?? "";
      const tokens = new Set(words(`${skill.name} ${description.slice(0, 2_000)}`));
      const matchedTerms = terms.filter((word) => tokens.has(word));
      const named = words(skill.name);
      return {
        name: skill.name,
        description: description.slice(0, 280),
        matchedTerms,
        explicit: references.has(skill.name.toLowerCase()),
        score: matchedTerms.length + matchedTerms.filter((term) => named.includes(term)).length * 2,
      };
    })
    .filter(
      (skill) =>
        skill.explicit ||
        (skill.score >= 3 && (skill.matchedTerms.length >= 2 || terms.length === 1)),
    )
    .sort(
      (a, b) =>
        Number(b.explicit) - Number(a.explicit) ||
        b.score - a.score ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 3)
    .map(({ score: _score, explicit: _explicit, ...skill }) => skill);
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    mode: "advisory",
    automaticExecution: false,
    judge: "local",
    reservePercent: RESERVE_PERCENT,
    recommendedInstanceId: recommended?.instanceId ?? null,
    accounts,
    skills,
    skillCatalogAvailable: catalog !== undefined,
  };
}
