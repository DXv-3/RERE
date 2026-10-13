import type {
  CampaignBoard,
  CampaignPost,
  CampaignSummary,
  ContentStudio,
  EnvironmentId,
  StudioBrief,
  StudioCommand,
  StudioScene,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { StudioGenerationRecovery } from "./StudioGenerationRecovery";
import { CampaignGenerationList } from "./CampaignGenerationList";
import { CampaignStudioCalendar } from "./CampaignStudioCalendar";
import { StudioBriefEditor, StudioStoryboard } from "./CampaignStudioEditor";
import { CampaignStudioLibrary } from "./CampaignStudioLibrary";
import { CampaignStudioRenders } from "./CampaignStudioRenders";
import { CampaignStudioThread } from "./CampaignStudioThread";
import { studioDraftProblems } from "./studio.logic";
import { useCampaignBoard, type CampaignRun } from "./useCampaigns";
import { uploadStudioFile } from "./studioUpload";
import { CampaignStudioActivity } from "./CampaignStudioActivity";
import { CampaignStudioBudget } from "./CampaignStudioBudget";

const EMPTY_CAMPAIGNS: readonly CampaignSummary[] = [];

type Draft = {
  readonly revision: number;
  readonly brief: StudioBrief;
  readonly scenes: readonly StudioScene[];
};

export function CampaignStudio({
  studio: incoming,
  environmentId,
  campaignName,
  campaigns = EMPTY_CAMPAIGNS,
  brandNotes = "",
  generation,
  posts,
  isAdministrator,
  run,
  onOpenPost,
  onNewPost,
  refresh,
}: {
  readonly studio: ContentStudio;
  readonly environmentId: EnvironmentId;
  readonly campaignName: string;
  readonly campaigns?: readonly CampaignSummary[];
  readonly brandNotes?: string;
  readonly generation: CampaignBoard["generation"];
  readonly posts: readonly CampaignPost[];
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  readonly onOpenPost: (id: string) => void;
  readonly onNewPost: () => void;
  readonly refresh: () => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<"Create" | "Library" | "Calendar" | "Activity">("Create");
  const [reuseCampaignId, setReuseCampaignId] = useState<string | null>(null);
  const reuse = useCampaignBoard(
    environmentId,
    reuseCampaignId !== null && tab === "Library",
    reuseCampaignId,
  );
  const [held, setHeld] = useState(incoming);
  // A command result can arrive before the board stream. Never regress to that older snapshot.
  const studio = incoming.revision > held.revision ? incoming : held;
  if (incoming.revision > held.revision) setHeld(incoming);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedScenes, setSelectedScenes] = useState<readonly string[]>([]);
  const [selectedJobs, setSelectedJobs] = useState<readonly string[]>([]);
  const [submittedJobs, setSubmittedJobs] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const brief = draft?.brief ?? studio.brief;
  const scenes = draft?.scenes ?? studio.scenes;
  const conflict = draft !== null && draft.revision !== studio.revision;
  const edit = (patch: Partial<Pick<Draft, "brief" | "scenes">>) =>
    setDraft((current) => ({
      revision: current?.revision ?? studio.revision,
      brief: current?.brief ?? studio.brief,
      scenes: current?.scenes ?? studio.scenes,
      ...patch,
    }));
  const act = async (command: StudioCommand): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await run(command);
      if (!outcome.ok) {
        setError(outcome.message || "The request was interrupted. Your edits are preserved.");
        refresh();
        return false;
      }
      if (outcome.value.kind === "studio") setHeld(outcome.value.studio);
      if (outcome.value.kind === "post") onOpenPost(outcome.value.post.id);
      setNotice(
        command.command === "studio.generate"
          ? "Proposals created. Review each provider, model and cost below before approving spend."
          : command.command === "studio.post"
            ? "Created a draft post."
            : "Saved.",
      );
      return true;
    } catch {
      setError(
        "The request could not be confirmed. Refresh before retrying; your edits are preserved.",
      );
      refresh();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const uploadFiles = async (files: readonly File[]) => {
    if (busy || draft !== null || !studio.brief.sourceThreadId)
      throw new Error("Save the linked campaign brief before uploading.");
    setBusy(true);
    setError(null);
    let revision = studio.revision;
    let count = 0;
    try {
      for (const file of files) {
        const upload = await uploadStudioFile(environmentId, file);
        try {
          const outcome = await run({
            command: "studio.importUploaded",
            campaignId: studio.campaignId,
            expectedRevision: revision,
            attachmentId: upload.attachmentId,
            kind: upload.kind,
          });
          if (!outcome.ok || outcome.value.kind !== "studio")
            throw new Error(outcome.ok ? "The import result was not confirmed." : outcome.message);
          revision = outcome.value.studio.revision;
          setHeld(outcome.value.studio);
          count++;
        } finally {
          upload.release();
        }
      }
      setNotice(`${count} assets uploaded. Review them in Library.`);
    } catch (cause) {
      const message = `${count} of ${files.length} files imported. ${cause instanceof Error ? cause.message : "Import interrupted. Refresh before retrying."}`;
      setError(message);
      throw new Error(message, { cause });
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const save = async () => {
    const problems = studioDraftProblems(brief, scenes);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    const snapshot = draft;
    if (
      await act({
        command: "studio.save",
        campaignId: studio.campaignId,
        expectedRevision: draft?.revision ?? studio.revision,
        brief: {
          ...brief,
          references: brief.references.map((value) => value.trim()).filter(Boolean),
        },
        scenes,
      })
    ) {
      setDraft((current) => (current === snapshot ? null : current));
    }
  };
  const jobs = generation.jobs.filter((job) =>
    studio.generationLinks.some((link) => link.jobId === job.id),
  );
  const reviewJobs = jobs.filter(
    (job) =>
      job.status === "needs-approval" &&
      selectedJobs.includes(job.id) &&
      !submittedJobs.includes(job.id),
  );
  const knownTotal = reviewJobs.reduce((sum, job) => sum + (job.estimatedUsd ?? 0), 0);
  const unknownJobs = reviewJobs.filter((job) => job.estimatedUsd === null);
  const unknownReservation = unknownJobs.reduce((sum, job) => sum + (job.allowanceUsd ?? 0), 0);
  const approveSelected = async () => {
    if (busy || !isAdministrator || reviewJobs.length === 0) return;
    const reviewed = [...reviewJobs];
    setBusy(true);
    setError(null);
    setNotice(null);
    const approved: string[] = [];
    const failures: string[] = [];
    try {
      for (const job of reviewed) {
        try {
          const result = await run({ command: "generation.approve", jobId: job.id });
          if (result.ok) approved.push(job.id);
          else failures.push(`${job.model}: ${result.message || "Approval interrupted"}`);
        } catch {
          failures.push(`${job.model}: Approval could not be confirmed; refresh before retrying.`);
        }
      }
      setSubmittedJobs((current) => [...current, ...reviewed.map((job) => job.id)]);
      setSelectedJobs([]);
      setNotice(
        `${approved.length} of ${reviewed.length} reviewed jobs approved. No jobs were regenerated or retried.`,
      );
      if (failures.length) setError(failures.join(" "));
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const canUseSaved = draft === null && studio.brief.sourceThreadId !== null;
  return (
    <section aria-label={`Content Studio for ${campaignName}`} className="space-y-4">
      <CampaignStudioBudget budget={studio.budget} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Content Studio</h3>
          <p className="text-xs text-muted-foreground">
            {campaignName} · 15–60 second ads · revision {studio.revision}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || conflict} onClick={() => void save()}>
            {draft ? "Save changes" : "Save brief"}
          </Button>
          {draft && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Discard edits
            </Button>
          )}
        </div>
      </div>
      {conflict && (
        <Alert variant="warning">
          <AlertDescription>
            A newer revision arrived while you were editing. Your edits are preserved. Review the
            latest saved brief before applying your draft.
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={() => setDraft(null)}>
                Load latest and discard edits
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setDraft((current) =>
                    current ? { ...current, revision: studio.revision } : null,
                  )
                }
              >
                Keep my edits on latest revision
              </Button>
            </div>
            <details className="mt-2">
              <summary>Latest saved brief and scenes</summary>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify({ brief: studio.brief, scenes: studio.scenes }, null, 2)}
              </pre>
            </details>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)]">
        <div className="min-w-0 space-y-4">
          <nav aria-label="Studio views" className="flex flex-wrap gap-2">
            {(["Create", "Library", "Calendar", "Activity"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={tab === value ? "default" : "outline"}
                aria-current={tab === value ? "page" : undefined}
                onClick={() => setTab(value)}
              >
                {value}
              </Button>
            ))}
          </nav>
          {!canUseSaved && (
            <p className="text-xs text-muted-foreground">
              {draft
                ? "Save your changes before generating, importing or rendering."
                : "Link a workspace conversation and save the brief to start."}
            </p>
          )}
          <div hidden={tab !== "Create"} inert={tab !== "Create"}>
            <div className="space-y-6">
              <fieldset disabled={busy} className="min-w-0 space-y-6">
                <StudioBriefEditor brief={brief} onChange={(value) => edit({ brief: value })} />
                <div id={`${id}-storyboard`}>
                  <StudioStoryboard
                    environmentId={environmentId}
                    savedBrief={studio.brief}
                    brandNotes={brandNotes}
                    scenes={scenes}
                    assets={studio.assets}
                    onChange={(value) => edit({ scenes: value })}
                  />
                </div>
              </fieldset>
              <div className="space-y-2">
                <fieldset disabled={busy || !canUseSaved} className="space-y-2">
                  <legend className="mb-2 text-sm font-medium">
                    Scenes to generate or regenerate
                  </legend>
                  {studio.scenes.map((scene, index) => (
                    <label key={scene.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedScenes.includes(scene.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelectedScenes((current) =>
                            checked
                              ? [...current, scene.id]
                              : current.filter((value) => value !== scene.id),
                          );
                        }}
                      />
                      {index + 1}. {scene.title || "Untitled scene"}
                    </label>
                  ))}
                </fieldset>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    busy ||
                    !canUseSaved ||
                    !selectedScenes.some((sceneId) =>
                      studio.scenes.some((scene) => scene.id === sceneId),
                    )
                  }
                  onClick={() =>
                    void act({
                      command: "studio.generate",
                      campaignId: studio.campaignId,
                      expectedRevision: studio.revision,
                      sceneIds: studio.scenes
                        .filter((scene) => selectedScenes.includes(scene.id))
                        .map((scene) => scene.id),
                    })
                  }
                >
                  Prepare selected scenes
                </Button>
                <Button
                  disabled={busy || !canUseSaved || studio.scenes.length === 0}
                  onClick={() =>
                    void act({
                      command: "studio.generate",
                      campaignId: studio.campaignId,
                      expectedRevision: studio.revision,
                      sceneIds: studio.scenes.map((scene) => scene.id),
                    })
                  }
                >
                  Prepare generation review
                </Button>
                <p className="text-xs text-muted-foreground">
                  Creates proposals for the saved scenes. Each paid job waits for your approval.
                </p>
              </div>
              {jobs.length > 0 && (
                <section aria-label="Generation review" className="space-y-3">
                  <h3 className="text-sm font-semibold">Generation review</h3>
                  {isAdministrator && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      <p className="text-sm">
                        {reviewJobs.length} selected · known estimates ${knownTotal.toFixed(2)} +{" "}
                        {unknownJobs.length} unknown-price jobs with $
                        {unknownReservation.toFixed(2)} in allowances.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Combined reservation: ${(knownTotal + unknownReservation).toFixed(2)}.
                        Review each selected provider, model and prompt below. Allowances are
                        reservations, not provider quotes or billing ceilings.
                      </p>
                      <Button
                        size="sm"
                        disabled={
                          busy ||
                          reviewJobs.length === 0 ||
                          unknownJobs.some((job) => job.allowanceUsd === undefined)
                        }
                        onClick={() => void approveSelected()}
                      >
                        Approve selected jobs and spend
                      </Button>
                    </div>
                  )}
                  {jobs.map((job) => (
                    <div key={job.id} className="space-y-2 rounded-md border border-border p-3">
                      {isAdministrator && job.status === "needs-approval" && (
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            disabled={busy || submittedJobs.includes(job.id)}
                            checked={selectedJobs.includes(job.id)}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setSelectedJobs((current) =>
                                checked
                                  ? [...current, job.id]
                                  : current.filter((value) => value !== job.id),
                              );
                            }}
                          />
                          Include {job.model} in approval batch
                        </label>
                      )}
                      <p className="text-sm font-medium">
                        {job.connector} · {job.model}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {job.options.durationSeconds ?? "—"} seconds ·{" "}
                        {job.options.resolution ?? "Provider default"} ·{" "}
                        {job.estimatedUsd === null
                          ? "Price unknown — review the spend allowance"
                          : `Estimated $${job.estimatedUsd.toFixed(2)}`}{" "}
                        ·{" "}
                        {job.allowanceUsd !== undefined
                          ? `Proposed allowance $${job.allowanceUsd.toFixed(2)} · `
                          : ""}
                        {job.estimateNote}
                      </p>
                      {isAdministrator && job.submissionState === "uncertain" && (
                        <StudioGenerationRecovery jobId={job.id} run={run} disabled={busy} />
                      )}
                      <fieldset disabled={busy || submittedJobs.includes(job.id)}>
                        <CampaignGenerationList
                          environmentId={environmentId}
                          jobs={[job]}
                          isAdministrator={isAdministrator}
                          run={run}
                        />
                      </fieldset>
                    </div>
                  ))}
                </section>
              )}
              <CampaignStudioRenders
                studio={studio}
                environmentId={environmentId}
                busy={busy}
                canUseSaved={canUseSaved}
                isAdministrator={isAdministrator}
                act={act}
                onRevise={() =>
                  document.getElementById(`${id}-storyboard`)?.scrollIntoView({ block: "start" })
                }
              />
            </div>
          </div>
          {tab === "Library" && (
            <CampaignStudioLibrary
              onUploadFiles={uploadFiles}
              reuseCampaigns={campaigns.filter((campaign) => campaign.id !== studio.campaignId)}
              reuseCampaignId={reuseCampaignId}
              onReuseCampaignChange={setReuseCampaignId}
              reuseLoading={reuse.loading}
              reuseError={
                reuse.error ? "Could not load this campaign’s assets. Check its connection." : null
              }
              reusableAssets={
                reuse.postsReady && reuse.board?.studio?.campaignId === reuseCampaignId
                  ? reuse.board.studio.assets
                      .filter((asset) => asset.approved)
                      .map((asset) => ({
                        campaignId: reuseCampaignId!,
                        campaignName:
                          campaigns.find((c) => c.id === reuseCampaignId)?.name ?? "Campaign",
                        asset,
                      }))
                  : []
              }
              onReuseAsset={(sourceCampaignId, assetId) =>
                act({
                  command: "studio.asset.reuse",
                  campaignId: studio.campaignId,
                  expectedRevision: studio.revision,
                  sourceCampaignId,
                  assetId,
                })
              }
              studio={studio}
              environmentId={environmentId}
              busy={busy}
              canUseSaved={canUseSaved}
              isAdministrator={isAdministrator}
              act={act}
            />
          )}
          {tab === "Activity" && (
            <CampaignStudioActivity
              studio={studio}
              jobs={jobs}
              busy={busy}
              isAdministrator={isAdministrator}
              act={act}
              run={run}
              onRevise={() => setTab("Create")}
            />
          )}
          {tab === "Calendar" && (
            <CampaignStudioCalendar posts={posts} onOpenPost={onOpenPost} onNewPost={onNewPost} />
          )}
        </div>
        <CampaignStudioThread
          campaignId={studio.campaignId}
          campaignName={campaignName}
          savedBrief={studio.brief}
          environmentId={environmentId}
          sourceThreadId={brief.sourceThreadId}
          linkedThreadId={studio.brief.sourceThreadId}
          onChange={(sourceThreadId) => edit({ brief: { ...brief, sourceThreadId } })}
        />
      </div>
    </section>
  );
}
