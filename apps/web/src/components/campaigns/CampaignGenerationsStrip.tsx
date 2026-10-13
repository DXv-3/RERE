import type {
  CampaignClient,
  CampaignGenerationBoard,
  CampaignGenerationJob,
  EnvironmentId,
} from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { CampaignGenerationList } from "./CampaignGenerationList";
import { jobsForClient, spendSummary, waitingForApprovalCount } from "./generation.logic";
import type { CampaignRun } from "./useCampaigns";

const SHOWN = 4;

/**
 * Recent generations for the chosen campaign's client, under the board. Generate is for
 * administrators; everyone else is told why it is off. Spend is the owner's business, so only an
 * administrator sees it.
 */
export function CampaignGenerationsStrip({
  environmentId,
  generation,
  client,
  isAdministrator,
  run,
  onGenerate,
  onAddToPost,
  onMakeVideo,
}: {
  readonly environmentId: EnvironmentId;
  readonly generation: CampaignGenerationBoard;
  readonly client: CampaignClient | undefined;
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  readonly onGenerate: () => void;
  readonly onAddToPost: (job: CampaignGenerationJob) => void;
  readonly onMakeVideo: (job: CampaignGenerationJob) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const jobs = useMemo(
    () => (client === undefined ? [] : jobsForClient(generation.jobs, client.id)),
    [generation.jobs, client],
  );
  const minute = useNowMinute();
  const now = `${minute}:00.000Z`;
  const waiting = waitingForApprovalCount(jobs);
  const shown = showAll ? jobs : jobs.slice(0, SHOWN);
  const clientName = client?.name ?? "this client";
  return (
    <section aria-label="Generations" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Generations
          {waiting > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-2xs text-foreground">
              {waiting} waiting for approval
            </span>
          ) : null}
        </h4>
        <Button
          size="sm"
          variant="outline"
          className="ms-auto"
          disabled={!isAdministrator || client === undefined}
          onClick={onGenerate}
        >
          <SparklesIcon aria-hidden />
          Generate
        </Button>
      </div>
      {isAdministrator ? (
        client === undefined ? null : (
          <p className="text-xs text-muted-foreground">
            {spendSummary(
              generation.spend.find((entry) => entry.clientId === client.id),
              jobs,
              now,
            )}
          </p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">
          Only an administrator can generate, approve or see spend.
        </p>
      )}
      {jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nothing has been generated for {clientName} yet.
        </p>
      ) : (
        <>
          <CampaignGenerationList
            environmentId={environmentId}
            jobs={shown}
            isAdministrator={isAdministrator}
            run={run}
            onAddToPost={onAddToPost}
            onMakeVideo={onMakeVideo}
          />
          {jobs.length > SHOWN ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="self-start"
              aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? "Show Fewer" : `Show All ${jobs.length}`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
