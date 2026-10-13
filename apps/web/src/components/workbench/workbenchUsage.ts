import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  allowanceTone,
  cursorAllowanceWindowId,
  cursorDisplayWindows,
  remainingPercent,
  type AllowanceTone,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";

type UsageProvider = Pick<ServerProvider, "displayName" | "driver" | "usageLimits">;

function selectedUsageWindow(
  provider: UsageProvider,
  model?: string,
): ServerProviderUsageWindow | undefined {
  const reported = provider.usageLimits?.windows ?? [];
  const windows = provider.driver === "cursor" ? cursorDisplayWindows(reported) : reported;
  const weekly = windows.filter((window) => window.kind === "weekly");
  const selected =
    provider.driver === "cursor" && model
      ? windows.find((window) => window.id === cursorAllowanceWindowId(model))
      : undefined;
  return (
    selected ??
    (weekly.length ? weekly : windows).toSorted(
      (a, b) => remainingPercent(a) - remainingPercent(b),
    )[0]
  );
}

/** A runtime driver may host several unrelated subscriptions and API accounts. */
export function currentProviderUsageLabel(
  provider: UsageProvider | undefined,
  model?: string,
): string {
  if (!provider) return "Subscription Usage";
  const name = provider.displayName || provider.driver;
  const window = selectedUsageWindow(provider, model);
  if (!window) return `${name} · Usage Unavailable`;
  const label = window.kind === "weekly" ? "Weekly" : window.label;
  const stale = provider.usageLimits?.unavailable ? " · Last Reported" : "";
  const remaining = Math.round(remainingPercent(window));
  if (provider.driver === "cursor" && remaining <= 0) {
    return `${name} · ${label} used up${stale}`;
  }
  return `${name} · ${label} ${remaining}% Left${stale}`;
}

/** Red, amber, or green for the allowance the label is describing. */
export function currentProviderUsageTone(
  provider: UsageProvider | undefined,
  model?: string,
): AllowanceTone | null {
  if (!provider) return null;
  const window = selectedUsageWindow(provider, model);
  return window ? allowanceTone(window) : null;
}

const LOW_ALLOWANCE_PERCENT = 10;

export interface UsageAlert {
  /** `empty` is red, `low` is amber. */
  readonly level: "empty" | "low";
  readonly message: string;
}

/**
 * The worst allowance across every account: used up, or under 10% left. Null
 * when nothing needs attention. The message names the account when it is not
 * the only one, and counts the others.
 */
export function usageAlert(accounts: readonly LimitAccount[]): UsageAlert | null {
  const hits = accounts.flatMap((account) =>
    account.limits.windows
      .map((window) => ({ account, window, remaining: remainingPercent(window) }))
      .filter((hit) => hit.remaining < LOW_ALLOWANCE_PERCENT),
  );
  const worst = hits.toSorted((a, b) => a.remaining - b.remaining)[0];
  if (!worst) return null;
  const name = worst.account.displayName || worst.account.driver;
  const kind = worst.window.kind === "weekly" ? "weekly" : worst.window.label.toLowerCase();
  const empty = worst.remaining <= 0;
  const state = empty ? "is used up" : `is almost used up (${Math.round(worst.remaining)}% left)`;
  const more = hits.length - 1;
  return {
    level: empty ? "empty" : "low",
    message: `${name} ${kind} allowance ${state}${more > 0 ? `, and ${more} more` : ""}`,
  };
}
