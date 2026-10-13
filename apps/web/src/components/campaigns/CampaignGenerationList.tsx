import type { CampaignGenerationJob, EnvironmentId } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  BanIcon,
  CheckCircle2Icon,
  ClockIcon,
  HourglassIcon,
} from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { CampaignMediaThumb, useOpenPostMedia } from "./CampaignPostMedia";
import {
  generationRow,
  type GenerationAction,
  type GenerationRowState,
  type GenerationStatusIcon,
} from "./generation.logic";
import type { CampaignRun } from "./useCampaigns";

/** The status as an icon beside its words, so no state rests on colour alone. */
function StatusIcon({ icon }: { readonly icon: GenerationStatusIcon }) {
  switch (icon) {
    case "waiting":
      return <HourglassIcon aria-hidden className="size-3.5" />;
    case "queued":
      return <ClockIcon aria-hidden className="size-3.5" />;
    case "running":
      return <Spinner size="sm" />;
    case "done":
      return <CheckCircle2Icon aria-hidden className="size-3.5" />;
    case "failed":
      return <AlertTriangleIcon aria-hidden className="size-3.5" />;
    case "cancelled":
      return <BanIcon aria-hidden className="size-3.5" />;
  }
}

/**
 * Recent generation jobs, one compact row each: the file (a real frame for a video), the status in
 * words and an icon, what was asked for, who asked, what it costs, and the buttons the status
 * allows. One component serves the campaign board and Settings, so there is only one approval list
 * to learn. Approving and cancelling run through `run`; adding to a post and opening a file are
 * handed up or opened here.
 */
export function CampaignGenerationList({
  environmentId,
  jobs,
  isAdministrator,
  run,
  clientNameOf,
  onAddToPost,
  onMakeVideo,
}: {
  readonly environmentId: EnvironmentId;
  readonly jobs: ReadonlyArray<CampaignGenerationJob>;
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  /** When rows from several clients are mixed, names the client of each. */
  readonly clientNameOf?: ((clientId: string) => string | undefined) | undefined;
  /** Absent where there is no campaign to start a post in; the button is then left out. */
  readonly onAddToPost?: ((job: CampaignGenerationJob) => void) | undefined;
  /** Absent where there is no Generate form to open; "Make A Video From This" is then left out. */
  readonly onMakeVideo?: ((job: CampaignGenerationJob) => void) | undefined;
}) {
  const openMedia = useOpenPostMedia(environmentId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ readonly jobId: string; readonly message: string } | null>(
    null,
  );

  const act = async (
    job: CampaignGenerationJob,
    row: GenerationRowState,
    action: GenerationAction,
  ) => {
    if (action === "addToPost") {
      onAddToPost?.(job);
      return;
    }
    if (action === "makeVideo") {
      onMakeVideo?.(job);
      return;
    }
    if (action === "open") {
      if (job.sourceThreadId !== undefined && row.resultPath !== null) {
        openMedia(job.sourceThreadId, row.resultPath);
      }
      return;
    }
    setBusy(job.id);
    setError(null);
    const outcome = await run({
      command: action === "approve" ? "generation.approve" : "generation.cancel",
      jobId: job.id,
    });
    setBusy(null);
    if (!outcome.ok) setError({ jobId: job.id, message: outcome.message });
  };

  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {jobs.map((job) => {
        const row = generationRow(job, {
          isAdministrator,
          canAddToPost: onAddToPost !== undefined,
          canMakeVideo: onMakeVideo !== undefined,
        });
        const reasons = [
          ...new Set(
            row.actions.flatMap((entry) => (entry.reason === undefined ? [] : [entry.reason])),
          ),
        ];
        const clientName = clientNameOf?.(job.clientId);
        const file =
          row.resultPath === null ? undefined : { kind: "path" as const, value: row.resultPath };
        return (
          <li key={job.id} data-wb-cp-job={job.status} className="flex gap-3 py-2.5 first:pt-0">
            <CampaignMediaThumb
              environmentId={environmentId}
              sourceThreadId={job.sourceThreadId}
              item={file}
              kind={job.kind}
              className="size-12"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="flex flex-wrap items-center gap-x-1.5 text-xs font-medium">
                <StatusIcon icon={row.statusIcon} />
                <span>{row.statusLabel}</span>
                <span className="font-normal text-muted-foreground">
                  · {row.kindLabel}
                  {clientName === undefined ? "" : ` · ${clientName}`}
                </span>
              </p>
              <p className="line-clamp-2 text-sm break-words">{row.promptExcerpt}</p>
              <p className="text-xs text-muted-foreground">
                {row.requester} · {row.costNote}
              </p>
              {row.failure !== null ? (
                <p className="flex items-start gap-1 text-xs text-destructive-foreground">
                  <AlertTriangleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                  <span>{row.failure}</span>
                </p>
              ) : null}
              {row.waitingNote !== null ? (
                <p className="flex items-start gap-1 text-xs text-muted-foreground">
                  <HourglassIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                  <span>{row.waitingNote}</span>
                </p>
              ) : null}
              {row.actions.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {row.actions.map((entry) => (
                    <Button
                      key={entry.action}
                      size="xs"
                      variant={entry.action === "approve" ? "default" : "outline"}
                      disabled={!entry.enabled || busy !== null}
                      onClick={() => void act(job, row, entry.action)}
                    >
                      {busy === job.id &&
                      (entry.action === "approve" || entry.action === "cancel") ? (
                        <Spinner size="sm" />
                      ) : null}
                      {entry.label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {reasons.map((reason) => (
                <p key={reason} className="text-2xs text-muted-foreground">
                  {reason}
                </p>
              ))}
              {error?.jobId === job.id ? (
                <Alert variant="error">
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
