import { useId, useState } from "react";
import type {
  CampaignGenerationJob,
  ContentStudio,
  StudioCommand,
  StudioNarration,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { StudioGenerationRecovery } from "./StudioGenerationRecovery";
import { studioActivity } from "./studioActivity.logic";
import type { CampaignRun } from "./useCampaigns";

function NarrationRecovery({
  attempt,
  studio,
  disabled,
  act,
}: {
  readonly attempt: StudioNarration;
  readonly studio: ContentStudio;
  readonly disabled: boolean;
  readonly act: (command: StudioCommand) => Promise<boolean>;
}) {
  const id = useId();
  const [assetId, setAssetId] = useState("");
  const eligible = studio.assets.filter(
    (a) => a.kind === "audio" && a.sourceThreadId === attempt.sourceThreadId,
  );
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm">
        Do not resubmit this paid request. Check ElevenLabs history, download any existing audio and
        import it into Library. Recovering audio keeps the allowance reserved; the actual charge
        remains unreported.
      </p>
      <Label htmlFor={id}>Recovered audio from Library</Label>
      <select
        id={id}
        className="w-full rounded-md border border-input bg-background p-2 text-sm"
        value={assetId}
        onChange={(event) => setAssetId(event.currentTarget.value)}
      >
        <option value="">Choose the existing narration audio</option>
        {eligible.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.file}
          </option>
        ))}
      </select>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || !eligible.some((a) => a.id === assetId)}
        onClick={() =>
          void act({
            command: "studio.narration.reconcile",
            campaignId: studio.campaignId,
            narrationId: attempt.id,
            assetId,
          })
        }
      >
        Confirm this is the recovered narration
      </Button>
    </div>
  );
}

export function CampaignStudioActivity({
  studio,
  jobs,
  busy,
  isAdministrator,
  act,
  run,
  onRevise,
}: {
  readonly studio: ContentStudio;
  readonly jobs: readonly CampaignGenerationJob[];
  readonly busy: boolean;
  readonly isAdministrator: boolean;
  readonly act: (command: StudioCommand) => Promise<boolean>;
  readonly run: CampaignRun;
  readonly onRevise: () => void;
}) {
  const activity = studioActivity(studio, jobs);
  return (
    <section aria-label="Studio activity" className="space-y-3">
      <h3 className="text-sm font-semibold">Activity</h3>
      {activity.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Generation, narration and render jobs will appear here.
        </p>
      )}
      <ul className="space-y-3">
        {activity.map((item) => (
          <li
            key={`${item.kind}:${item.id}`}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <p className="text-sm font-medium">
              {item.kind === "generation"
                ? `${item.job.kind} · ${item.job.model}`
                : item.kind === "narration"
                  ? "Narration · ElevenLabs"
                  : `Render revision ${item.job.revision} · ${item.job.aspectRatio}`}
              {" · "}
              {item.unresolved ? "Needs reconciliation" : item.job.status}
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(item.at).toLocaleString()} · {item.id}
            </p>
            {item.job.error && (
              <p role="alert" className="text-xs">
                {item.job.error}
              </p>
            )}
            {item.kind === "generation" && (
              <>
                <p className="text-xs text-muted-foreground">
                  Reserved:{" "}
                  {item.job.reservedUsd == null
                    ? "unreported"
                    : `$${item.job.reservedUsd.toFixed(2)}`}{" "}
                  · Actual charge: unreported
                </p>
                {item.job.waitingNote && <p className="text-xs">{item.job.waitingNote}</p>}
                {item.unresolved && (
                  <StudioGenerationRecovery
                    jobId={item.id}
                    run={run}
                    disabled={busy || !isAdministrator}
                  />
                )}
                {item.job.status === "running" && !item.unresolved && (
                  <p className="text-xs text-muted-foreground">
                    The server resumes polling saved provider receipts after a restart.
                  </p>
                )}
              </>
            )}
            {item.kind === "narration" && (
              <>
                <p className="text-xs text-muted-foreground">
                  Allowance: ${item.job.allowanceUsd.toFixed(2)} · Reserved:{" "}
                  {item.job.expenseId ? `$${item.job.allowanceUsd.toFixed(2)}` : "$0.00"} · Actual
                  charge:{" "}
                  {item.job.confirmedUsd === null
                    ? "unreported"
                    : `$${item.job.confirmedUsd.toFixed(2)}`}
                </p>
                <details className="text-xs">
                  <summary>Approved narration and provenance</summary>
                  <p className="whitespace-pre-wrap">{item.job.text}</p>
                  <p>
                    Voice: {item.job.voiceId} · Model: {item.job.model}
                  </p>
                  <p>Workspace thread: {item.job.sourceThreadId}</p>
                  {item.job.providerRequestId && (
                    <p>Provider receipt: {item.job.providerRequestId}</p>
                  )}
                  {item.job.assetId && <p>Saved audio: {item.job.assetId}</p>}
                </details>
                {item.unresolved && (
                  <NarrationRecovery
                    attempt={item.job}
                    studio={studio}
                    disabled={busy || !isAdministrator}
                    act={act}
                  />
                )}
                {item.job.status === "failed" && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      busy ||
                      !isAdministrator ||
                      studio.brief.sourceThreadId !== item.job.sourceThreadId
                    }
                    onClick={() =>
                      void act({
                        command: "studio.narrate",
                        campaignId: studio.campaignId,
                        expectedRevision: studio.revision,
                        requestId: item.job.id,
                        text: item.job.text,
                        voiceId: item.job.voiceId,
                        allowanceUsd: item.job.allowanceUsd,
                      })
                    }
                  >
                    Retry approved narration preflight
                  </Button>
                )}
              </>
            )}
            {item.kind === "render" && item.job.status === "failed" && (
              <Button size="xs" variant="outline" disabled={busy} onClick={onRevise}>
                Review storyboard before rendering again
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
