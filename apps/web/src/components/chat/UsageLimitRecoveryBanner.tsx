import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Another connected account the thread could carry on with. */
export interface RecoveryAccount {
  instanceId: string;
  name: string;
  model: string;
}

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  /** Accounts other than the one that hit its limit. Empty hides the option. */
  accounts: ReadonlyArray<RecoveryAccount>;
  onContinueOn: (account: RecoveryAccount) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt, stoppedAt, accounts } = props;
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? `Resets ${new Date(resetAt).toLocaleString()}`
      : "Reset time unavailable; retry manually",
    actions:
      canSchedule || accounts.length > 0 ? (
        <div className="flex flex-col gap-2">
          {canSchedule ? <RecoveryActions key={`${runId}:${resetAt}`} {...props} /> : null}
          {accounts.length > 0 ? <ContinueElsewhere key={runId} {...props} /> : null}
        </div>
      ) : null,
  };
}

/**
 * Moves the thread to another account. The switch is spelled out and waits for a
 * second click, so a thread never changes account on its own.
 */
function ContinueElsewhere({ accounts, onContinueOn }: RecoveryProps) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(accounts[0]?.instanceId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = accounts.find((item) => item.instanceId === chosen) ?? accounts[0];
  if (!account) return null;
  if (!open)
    return (
      <div>
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
          Continue on another account
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-2 text-xs">
      {accounts.length > 1 ? (
        <select
          aria-label="Account To Continue On"
          className="self-start rounded border border-border bg-background px-1.5 py-1"
          value={account.instanceId}
          onChange={(event) => setChosen(event.target.value)}
        >
          {accounts.map((item) => (
            <option key={item.instanceId} value={item.instanceId}>
              {item.name}
            </option>
          ))}
        </select>
      ) : null}
      <p>
        This thread will continue on {account.name} with {account.model}. The conversation so far is
        handed over as context, and later messages stay on {account.name} until you pick another
        model.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            void onContinueOn(account)
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not switch accounts."),
              )
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Switching..." : `Continue on ${account.name}`}
        </Button>
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RecoveryActions({ runId, resetAt, recovery, snoozedUntil, onChange }: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      setNowMs(Date.now());
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
    setPending(false);
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
      </Button>
      {!snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={pending || Date.parse(resetAt!) <= nowMs}
          onClick={() => void toggle("snooze")}
        >
          {pending ? "Saving..." : "Snooze until reset"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
