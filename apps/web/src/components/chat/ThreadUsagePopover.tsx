import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
} from "../../lib/contextWindow";
import { aggregateThreadUsage, formatThreadUsageCost } from "../../lib/threadUsage";
import { useThreadProjection } from "../../state/entities";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function UsageRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function UsageDetails({
  environmentId,
  threadId,
}: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
  )?.projection;
  const details = useMemo(() => {
    if (!projection) return null;
    const turns = projection.providerTurns;
    const providerThreads = projection.providerThreads;
    let liveUsage = null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const usage = turns[index]?.tokenUsage;
      if (usage !== undefined) {
        liveUsage = usage;
        break;
      }
    }
    return {
      context: deriveLatestContextWindowSnapshot(
        [],
        liveUsage,
        providerThreads.find((thread) => thread.id === projection.thread.activeProviderThreadId),
      ),
      totals: aggregateThreadUsage(turns, providerThreads),
    };
  }, [projection]);
  if (details === null) {
    return <p className="text-muted-foreground text-xs">Usage is still loading.</p>;
  }
  const { context, totals } = details;
  const hasTokens = totals.reportedTurns > 0;
  return (
    <div className="grid gap-2 text-xs">
      <p className="font-medium text-sm">Context and usage</p>
      <dl className="grid gap-1">
        {context ? (
          <UsageRow
            label="Context used"
            value={
              context.maxTokens
                ? `${formatContextWindowTokens(context.usedTokens)} / ${formatContextWindowTokens(context.maxTokens)}`
                : formatContextWindowTokens(context.usedTokens)
            }
          />
        ) : null}
        {hasTokens ? (
          <>
            <UsageRow label="Tokens in" value={formatContextWindowTokens(totals.inputTokens)} />
            <UsageRow label="Tokens out" value={formatContextWindowTokens(totals.outputTokens)} />
            <UsageRow
              label="Cache read"
              value={formatContextWindowTokens(totals.cacheReadTokens)}
            />
            <UsageRow
              label="Cache write"
              value={formatContextWindowTokens(totals.cacheWriteTokens)}
            />
          </>
        ) : (
          <p className="text-muted-foreground">No token counts reported yet.</p>
        )}
        <UsageRow
          label="Cost"
          value={totals.cost ? formatThreadUsageCost(totals.cost) : "Cost not available"}
        />
        {totals.lastAnsweringModel ? (
          <UsageRow label="Last answered by" value={totals.lastAnsweringModel} />
        ) : null}
      </dl>
      <p className="text-muted-foreground">
        {`Sums this session's loaded runs (${totals.reportedTurns} of ${totals.loadedTurns} reported usage)${totals.partial ? ", some partial" : ""}${totals.excludesSubagents ? ", excluding subagents" : ""}. Cost is shown only when the provider reports it.`}
      </p>
    </div>
  );
}

/** The header's context chip; opens this thread's token and cost summary. */
export function ThreadUsagePopover({
  environmentId,
  threadId,
  contextPercent,
}: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly contextPercent: number;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger aria-label="Context and usage" data-wb-context-chip="" />}
        >
          <small>
            <span className="sr-only @[900px]/chat-header:not-sr-only">Context </span>
            {Math.round(contextPercent)}%
            <span className="sr-only @[900px]/chat-header:not-sr-only"> Used</span>
          </small>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Context and usage</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="md" align="end">
        <UsageDetails environmentId={environmentId} threadId={threadId} />
      </PopoverPopup>
    </Popover>
  );
}
