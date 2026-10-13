/**
 * Selection and pace maths for the provider limits view, shared by web and
 * mobile so both agree on which providers show, what "ahead of pace" means,
 * and how a reset is phrased.
 *
 * @module usageLimits
 */
import {
  type EnvironmentId,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "Combined usage across both allowances, not a separate quota.",
    exhausted: "Both allowances are used up.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Auto, Composer, and Grok use this allowance.",
    exhausted: "Auto, Composer, and Grok cannot run until this allowance resets.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description:
      "Claude, GPT, and Gemini use this allowance, including Opus. Composer and Grok use it only after Cursor Models runs out.",
    exhausted: "Claude, GPT, and Gemini cannot run until this allowance resets, including Opus.",
  },
] as const;

/** Composer and Grok draw on Cursor Models. Claude, GPT, Gemini, and the rest draw on Other Models. */
const CURSOR_MODELS_ALLOWANCE = /^(?:auto|composer|grok)(?:\b|[\s-])/iu;

export function usesCursorModelsAllowance(model: string): boolean {
  return CURSOR_MODELS_ALLOWANCE.test(model.trim());
}

export function cursorAllowanceWindowId(model: string): "autoPercentUsed" | "apiPercentUsed" {
  return usesCursorModelsAllowance(model) ? "autoPercentUsed" : "apiPercentUsed";
}

export function cursorUsageWindowDetails(id: string) {
  return CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
}

export function cursorWindowNote(id: string, exhausted: boolean): string | undefined {
  const details = cursorUsageWindowDetails(id);
  if (!details) return undefined;
  return exhausted ? details.exhausted : details.description;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

function reportedRemaining(window: {
  readonly usedPercent?: number;
  readonly remainingPercent?: number;
}): number {
  if (typeof window.remainingPercent === "number") return window.remainingPercent;
  if (typeof window.usedPercent === "number") {
    return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
  }
  return 100;
}

/**
 * Cursor's two usable pools, with a used-up pool first. The combined percentage
 * is omitted once both pools are present, because it can still look healthy
 * after Other Models is exhausted.
 */
export function cursorDisplayWindows<
  T extends {
    readonly id: string;
    readonly usedPercent?: number;
    readonly remainingPercent?: number;
  },
>(windows: readonly T[]): readonly T[] {
  const hasAuto = windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = windows.some((window) => window.id === "apiPercentUsed");
  const hasBothPools = hasAuto && hasApi;
  return windows
    .filter((window) => !hasBothPools || window.id !== "totalPercentUsed")
    .sort(
      (left, right) =>
        Number(reportedRemaining(left) > 0) - Number(reportedRemaining(right) > 0) ||
        cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id),
    );
}

/**
 * Providers that belong on the Limits view: enabled, installed, and one whose
 * driver reports subscription usage at all. A driver with no notion of usage
 * never sets `usageLimits`, so it has no row rather than an empty one.
 */
export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers?: readonly ServerProvider[] | undefined;
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

/** One destination per service, even when several accounts or environments use it. */
export function collectExternalUsageLinks(presentations: LimitPresentations) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = `${provider.displayName ?? provider.instanceId} on ${presentation.entry.target.label}`;
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

/** Prefer the reported email; use an identical credential when no email is available. */
function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

/**
 * One subscription account as the pooled views see it, whichever way it was
 * reported. Matching emails or credentials across environments name
 * one account. Its quota is one bucket, so counting it twice would misstate
 * what is left.
 */
export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  /** The instance's configured name, which is not sensitive; null for hub accounts. */
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  readonly accentColor: string | undefined;
  /** Environments the account is signed in on; empty when only a hub reports it. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  /** The hub that reported it, when no environment has it natively. */
  readonly sourceLabel: string | null;
  /** Where the displayed reset credit can be redeemed. */
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  readonly limits: ServerProviderUsageLimits;
}

/**
 * Every account with usable windows across the connected environments, one
 * entry per distinct account. The freshest reads supply windows and credits;
 * native instances supply names and environment labels.
 */
export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Redeeming through a hub also clears the routing cooldown that hub holds
    // for the account. Redeeming natively against the same subscription resets
    // it upstream but leaves the hub refusing to route to the account until
    // its own cooldown expires, so a hub target wins the redemption outright
    // while the displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    // Two instances on one machine sharing an account still name it once.
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    // Credits and their redemption target travel together. A failed credit
    // probe must not erase a successful read from another environment.
    const creditSource = creditSources.get(key);
    accounts.set(key, {
      ...previous,
      displayName: previous.displayName ?? next.displayName,
      plan: previous.plan ?? next.plan,
      accentColor: previous.accentColor ?? next.accentColor,
      environments,
      // A hub only names the account when no environment has it natively.
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(
        accountKey(provider.driver, provider.auth.email, provider.usageLimits) ??
          `${environmentId}:${provider.instanceId}`,
        {
          key: `${environmentId}:${provider.instanceId}`,
          driver: provider.driver,
          displayName: provider.displayName?.trim() || null,
          email: provider.auth.email,
          plan: provider.auth.label,
          accentColor: provider.accentColor,
          environments: [{ environmentId, label }],
          sourceLabel: null,
          redeem: { environmentId, input: { instanceId: provider.instanceId } },
          limits: provider.usageLimits,
        },
      );
    }
  }
  // Every hub account, including those a native instance also knows: the hub
  // may hold a fresher read of the same subscription, and the merge above
  // keeps the redeem target consistent with whichever snapshot wins.
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        merge(
          accountKey(account.driver, account.email, account.usageLimits) ??
            `${source.id}:${account.id}`,
          {
            key: `${source.id}:${account.id}`,
            driver: account.driver,
            displayName: account.email ? null : account.id.replace(/\.json$/i, ""),
            email: account.email,
            plan: account.plan,
            accentColor: undefined,
            environments: [],
            sourceLabel,
            redeem: account.usageLimits.resetCredits?.nextCreditId
              ? {
                  environmentId,
                  input: {
                    sourceId: source.id,
                    accountId: account.id,
                    creditId: account.usageLimits.resetCredits.nextCreditId,
                  },
                }
              : null,
            limits: account.usageLimits,
          },
        );
      }
    }
  }
  return [...accounts.values()];
}

/**
 * What the pooled views cannot draw as a bar: a hub that failed to read, a
 * provider whose probe failed. Accounts that can never report (API keys)
 * are left out; there is nothing for the user to act on. The environment
 * is named only when more than one is connected.
 */
export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices: string[] = [];
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      // An account that can never report (API key) is left out; one that
      // failed, or reported nothing at all, is worth a line.
      if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
      const notice = provider.usageLimits ? limitsNotice(provider.usageLimits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.push(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) {
        notices.push(`${label(environmentLabel, source.label)}: ${source.error}`);
      } else if (source.accounts.length === 0) {
        notices.push(`${label(environmentLabel, source.label)}: No accounts reported.`);
      }
    }
  }
  return notices;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
}

/**
 * One window id across every account that reports it: the pooled share left,
 * pace against the clock, and the resets in the order they will land, each
 * with the share of the pool it hands back.
 */
export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Fixed account positions across rows; a null window leaves a gap. */
  readonly columns: ReadonlyArray<{
    readonly account: LimitAccount;
    readonly window: ServerProviderUsageWindow | null;
  }>;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    /** Points of the pool the reset restores: the member's used share over the member count. */
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

/** Show Cursor's two usable pools instead of a combined percentage when both are available. */
export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver !== "cursor") return pool.windows;
  return cursorDisplayWindows(pool.windows);
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/**
 * Accounts grouped by driver, each with its windows pooled by kind and id.
 * Window ids are stable per provider, so a hub row and a native row for the
 * same window land in the same pool; the kind is part of the key because
 * Codex's `primary` is a position, not a duration (five hours on paid plans,
 * a month on Free/Go), and a monthly allowance must not average into a
 * five-hour pool. Pools order by kind, then first appearance.
 *
 * Accounts and columns share the session reset order, soonest first. When
 * no account reports a session window, use the first window by kind instead.
 * Missing reset times sort last, with account names and keys breaking ties.
 * Each window's reset list still follows its own clock.
 */
export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => window.kind === orderWindow?.kind && window.id === orderWindow.id,
      );
      return (window ? resetMillis(window) : null) ?? Number.POSITIVE_INFINITY;
    };
    const sorted = [...members].sort(
      (left, right) =>
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    return { driver, accounts: sorted, windows: poolWindows(sorted, now) };
  });
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, LimitPoolMember[]>();
  for (const account of accounts) {
    for (const window of account.limits.windows) {
      const key = `${window.kind}:${window.id}`;
      const list = byKey.get(key);
      if (list) list.push({ account, window });
      else byKey.set(key, [{ account, window }]);
    }
  }
  const pools = [...byKey.values()].map((members): LimitPoolWindow => {
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const usedPercent = members.reduce((sum, m) => sum + m.window.usedPercent, 0) / members.length;
    // Pace compares spend against the clock, so it is judged only over the
    // members that have a clock; a window with no reset would otherwise
    // count as spend with no time elapsed and skew the verdict.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null ? [] : [{ used: m.window.usedPercent, elapsed: share }];
    });
    const timedUsed = timed.reduce((sum, t) => sum + t.used, 0) / timed.length;
    const meanElapsed =
      timed.length > 0 ? timed.reduce((sum, t) => sum + t.elapsed, 0) / timed.length : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.window.usedPercent / members.length),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id: first.id,
      kind: first.kind,
      label: first.label,
      members,
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

/** The one-line status under a provider heading when there are no bars to draw. */
export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

/** Quota left in the window, 0..100. Bars and labels show what remains, as Codex does. */
export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Length of the allowance. A reported duration wins. A weekly window without one
 * is seven days, and a monthly window is the calendar month that ends at its
 * reset, which is how Cursor's billing cycle is measured.
 */
function windowLengthMs(window: ServerProviderUsageWindow): number | null {
  if (window.windowDurationMins !== undefined) {
    const length = window.windowDurationMins * MINUTE;
    return length > 0 ? length : null;
  }
  if (window.kind === "weekly") return 7 * DAY;
  if (window.kind !== "monthly") return null;
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  const end = DateTime.make(resetsAt);
  if (Option.isNone(end)) return null;
  const start = DateTime.subtract(end.value, { months: 1 });
  const length = resetsAt - DateTime.toEpochMillis(start);
  return length > 0 ? length : null;
}

/** Elapsed share of the window, 0..1, or null when its length or reset is unknown. */
export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  const length = windowLengthMs(window);
  if (resetsAt === null || length === null) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

export type LimitPace = "ahead" | "on" | "under";

/**
 * Usage against the clock. Spending evenly leaves the same share of quota as
 * there is time left in the window; within five points of that counts as on
 * pace, further ahead means the window may run dry first.
 */
export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** Red when nothing is left, amber under a quarter left, green otherwise. */
export type AllowanceTone = "empty" | "low" | "steady";

/** Under this much left an allowance turns amber. */
const LOW_ALLOWANCE_TONE_PERCENT = 25;

export function allowanceToneFromRemaining(remaining: number): AllowanceTone {
  if (remaining <= 0) return "empty";
  return remaining < LOW_ALLOWANCE_TONE_PERCENT ? "low" : "steady";
}

export function allowanceTone(window: ServerProviderUsageWindow): AllowanceTone {
  return allowanceToneFromRemaining(remainingPercent(window));
}

/** `2h 13m`, `3d 4h`, `12m`. */
export function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `resets in 2h 13m`, or null when the window has no reset. */
export function formatResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  return resetsAt <= now ? "resets now" : `resets in ${formatDuration(resetsAt - now)}`;
}

/** Allowances with the least left first, so an exhausted one leads. Ties keep their order. */
export function sortWindowsByRemaining<T extends ServerProviderUsageWindow>(
  windows: readonly T[],
): readonly T[] {
  return [...windows].sort((left, right) => remainingPercent(left) - remainingPercent(right));
}

/** The least left across an account's allowances, or null when it reports none. */
function leastRemaining(account: LimitAccount): number | null {
  const windows = account.limits.windows;
  return windows.length ? Math.min(...windows.map(remainingPercent)) : null;
}

/** Accounts whose tightest allowance has the least left first. Accounts reporting none go last. */
export function sortAccountsByRemaining(
  accounts: readonly LimitAccount[],
): readonly LimitAccount[] {
  return [...accounts].sort((left, right) => {
    const a = leastRemaining(left);
    const b = leastRemaining(right);
    if (a === null || b === null) return Number(a === null) - Number(b === null);
    return a - b;
  });
}

export interface ResetPhraseOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

function localDayNumber(at: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY);
}

/**
 * A reset in plain words: `Resets in 12 min`, `Resets in 3 h`,
 * `Resets tomorrow at 9:00 AM`, `Resets in 2 days`. Past times read
 * `Resetting now`, and a missing time `Reset time not reported`.
 */
export function formatResetPhrase(
  resetsAt: string | undefined,
  now: number,
  options: ResetPhraseOptions = {},
): string {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return "Reset time not reported";
  const ms = at - now;
  if (ms <= 0) return "Resetting now";
  if (ms < HOUR) return `Resets in ${Math.max(1, Math.floor(ms / MINUTE))} min`;
  if (ms < DAY) return `Resets in ${Math.floor(ms / HOUR)} h`;
  if (localDayNumber(at, options.timeZone) - localDayNumber(now, options.timeZone) === 1) {
    const time = new Intl.DateTimeFormat(options.locale, {
      timeZone: options.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
    return `Resets tomorrow at ${time}`;
  }
  const days = Math.floor(ms / DAY);
  return `Resets in ${days} ${days === 1 ? "day" : "days"}`;
}

/** The exact local date and time, for a tooltip. Empty when the time is missing or invalid. */
export function formatResetTitle(
  resetsAt: string | undefined,
  options: ResetPhraseOptions = {},
): string | undefined {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  return new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(at);
}

/** Limit commands are served by T3 from the same snapshots as Usage → Limits. */
export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

/** Handled by the client without sending a turn; anything with arguments stays an ordinary prompt. */
export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

/**
 * Whether Limits has anything to say about this driver. A source that failed to
 * read keeps no accounts, so its error counts for every driver rather than
 * disappearing until the next successful refresh.
 */
export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

/**
 * The drivers a set of sources would offer the command to, where a source that
 * failed to read counts for every driver. Two snapshots with the same coverage
 * need no catalog republish, however much their quotas moved.
 */
export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  return providers.map((provider) => {
    if (!hasProviderUsageLimits(provider.driver, providers, sources)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

/** A point-in-time report; never refreshes or guesses which pooled account serves a turn. */
export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected || !hasProviderUsageLimits(selected.driver, providers, sources)) return null;
  const native = providersWithLimits(providers).filter(
    (provider) => provider.driver === selected.driver,
  );
  const nativeAccounts = new Set(
    native.flatMap((provider) => {
      const key = accountKey(provider.driver, provider.auth.email, provider.usageLimits);
      return key && provider.usageLimits?.windows.length && !provider.usageLimits.unavailable
        ? [key]
        : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const provider of native) {
    if (!provider.usageLimits) continue;
    const key = accountKey(provider.driver, provider.auth.email, provider.usageLimits);
    const hubCredits = sources
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          accountKey(account.driver, account.email, account.usageLimits) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    // Two independent decisions. Which balance to *display* follows whichever
    // snapshot is fresher. Which path to *redeem through* always prefers the
    // hub, because only the hub path clears the routing cooldown it holds for
    // that account; redeeming natively against the same account resets the
    // subscription upstream but leaves the hub refusing to route to it until
    // its own cooldown expires. A hub credit id that a fresher native redeem
    // already spent comes back as `alreadyRedeemed`, which still clears the
    // cooldown, so preferring it is safe even when the hub snapshot is stale.
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!provider.usageLimits.resetCredits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(provider.usageLimits.checkedAt));
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: showHubCredits
        ? { ...provider.usageLimits, resetCredits: hubCredits.account.usageLimits.resetCredits }
        : provider.usageLimits,
    });
  }
  for (const source of sources) {
    const matching = source.accounts.filter((account) => account.driver === selected.driver);
    for (const account of matching) {
      const key = accountKey(account.driver, account.email, account.usageLimits);
      if (key && nativeAccounts.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.id}`,
        sourceLabel: "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    // A source that failed to read has no accounts left to match on, so its
    // error is reported to every provider rather than silently dropped.
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
