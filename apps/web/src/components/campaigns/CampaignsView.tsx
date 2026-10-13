import type {
  Campaign,
  CampaignGenerationJob,
  CampaignSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { CampaignStudio } from "./CampaignStudio";
import { CampaignBoardPanel } from "./CampaignBoardPanel";
import { CampaignClientDialog } from "./CampaignClientDialog";
import { CampaignClientList } from "./CampaignClientList";
import { CampaignNameDialog } from "./CampaignNameDialog";
import { CampaignGenerateDialog } from "./CampaignGenerateDialog";
import { CampaignPostDialog, type PostPrefill } from "./CampaignPostDialog";
import { CampaignTemplatesDialog } from "./CampaignTemplatesDialog";
import type { TemplateId } from "./campaignTemplates.logic";
import { latestPostThread } from "./generation.logic";
import { useCampaignBoard, useCampaignCommand, useIsCampaignAdministrator } from "./useCampaigns";

type ClientDialog = { readonly clientId: string | null };
type CampaignDialog = { readonly clientId: string; readonly campaignId: string | null };

/**
 * The Campaigns view in the Agents tab: clients and their campaigns on the left, the chosen
 * campaign as a board on the right. Everything here reads one live stream from the server, so a
 * post an agent drafts or a person approves on another device shows up without a refresh.
 */
export function CampaignsView({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
}) {
  return (
    <section data-wb-campaigns="" aria-label="Campaigns">
      <h2>Campaigns</h2>
      {environmentId === null || !connected ? (
        <p data-wb-board-summary="" aria-live="polite">
          Connect To Your Agent Workspace To See Campaigns
        </p>
      ) : (
        <ConnectedCampaigns environmentId={environmentId} />
      )}
    </section>
  );
}

function ConnectedCampaigns({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const isAdministrator = useIsCampaignAdministrator(environmentId);
  const run = useCampaignCommand(environmentId);
  // The campaign whose posts are subscribed. Null until the first read says which exist.
  const [requested, setRequested] = useState<string | null>(null);
  const [clientDialog, setClientDialog] = useState<ClientDialog | null>(null);
  const [campaignDialog, setCampaignDialog] = useState<CampaignDialog | null>(null);
  const [postId, setPostId] = useState<string | "new" | null>(null);
  // Files a new post starts with, when it was opened from a finished generation.
  const [prefill, setPrefill] = useState<PostPrefill | null>(null);
  const [generating, setGenerating] = useState(false);
  const [workspace, setWorkspace] = useState<"studio" | "posts">("studio");
  /** The finished picture a video is being made from, when "Make A Video From This" opened the form. */
  const [videoFrom, setVideoFrom] = useState<CampaignGenerationJob | null>(null);
  const [templates, setTemplates] = useState<{ readonly initial: TemplateId | null } | null>(null);

  const { board, postsReady, loading, error, refresh } = useCampaignBoard(
    environmentId,
    true,
    requested,
  );
  // A campaign just created is chosen before the board that lists it arrives.
  const [justCreated, setJustCreated] = useState<Campaign | null>(null);
  const found = board?.campaigns.find((candidate) => candidate.id === requested);
  if (found !== undefined && justCreated !== null) setJustCreated(null);
  const campaign: CampaignSummary | null =
    found ??
    (justCreated !== null && justCreated.id === requested
      ? { ...justCreated, postCounts: {} }
      : null) ??
    board?.campaigns[0] ??
    null;
  // The first campaign is chosen once the list arrives, and again if the chosen one is deleted.
  if (board !== null && requested !== (campaign?.id ?? null)) setRequested(campaign?.id ?? null);

  const client = board?.clients.find((candidate) => candidate.id === campaign?.clientId);
  const posts =
    board === null || campaign === null
      ? []
      : board.posts.filter((post) => post.campaignId === campaign.id);
  const post =
    postId === null || postId === "new" ? null : (posts.find((p) => p.id === postId) ?? null);
  // A post opened here and then deleted elsewhere closes its dialog instead of showing a ghost.
  const postOpen = postId === "new" || (postId !== null && post !== null);

  const editingClient =
    clientDialog?.clientId == null
      ? undefined
      : board?.clients.find((candidate) => candidate.id === clientDialog.clientId);
  const editingCampaign =
    campaignDialog?.campaignId == null
      ? undefined
      : board?.campaigns.find((candidate) => candidate.id === campaignDialog.campaignId);
  const dialogClient = board?.clients.find(
    (candidate) => candidate.id === campaignDialog?.clientId,
  );

  if (error !== null && board === null) {
    return (
      <div role="alert" data-wb-error="">
        Could not load campaigns. {error}{" "}
        <button type="button" onClick={refresh}>
          Try Again
        </button>
      </div>
    );
  }
  if (loading || board === null) {
    return (
      <p data-wb-board-summary="" role="status" className="flex items-center gap-2">
        <Spinner size="sm" />
        Loading Campaigns…
      </p>
    );
  }

  const summary =
    board.clients.length === 0
      ? "No Clients Yet"
      : `${board.clients.length} ${board.clients.length === 1 ? "Client" : "Clients"}, ${board.campaigns.length} ${board.campaigns.length === 1 ? "Campaign" : "Campaigns"}`;

  return (
    <>
      <p data-wb-board-summary="" aria-live="polite">
        {summary}
      </p>
      {error !== null ? (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            Updates stopped arriving, so this may be out of date. {error}{" "}
            <button type="button" onClick={refresh}>
              Try Again
            </button>
          </AlertDescription>
        </Alert>
      ) : null}

      {board.clients.length === 0 ? (
        <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
          <p className="text-sm font-medium">No Clients Yet</p>
          <p className="text-xs text-muted-foreground">
            A client is a brand you make posts for, like Candid Studios or Savage Digital Solutions.
            Add one, then give it a campaign.
          </p>
          {isAdministrator ? (
            <Button size="sm" onClick={() => setClientDialog({ clientId: null })}>
              <PlusIcon aria-hidden />
              New Client
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only an administrator can add a client. Ask one to set it up.
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="flex w-full shrink-0 flex-col gap-3 lg:w-60">
            <CampaignClientList
              board={board}
              selectedCampaignId={campaign?.id ?? null}
              isAdministrator={isAdministrator}
              onSelect={(id) => {
                setRequested(id);
                setPostId(null);
              }}
              onEditClient={(clientId) => setClientDialog({ clientId })}
              onNewCampaign={(clientId) => setCampaignDialog({ clientId, campaignId: null })}
            />
            {isAdministrator ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setClientDialog({ clientId: null })}
              >
                <PlusIcon aria-hidden />
                New Client
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only an administrator can add clients or campaigns.
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {campaign === null ? (
              <div className="flex max-w-md flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
                <p className="text-sm font-medium">No Campaigns Yet</p>
                <p className="text-xs text-muted-foreground">
                  A campaign groups the posts for one push, like a launch or a month. Create one
                  under a client to start.
                </p>
                {isAdministrator && board.clients[0] !== undefined ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setCampaignDialog({ clientId: board.clients[0]!.id, campaignId: null })
                    }
                  >
                    <PlusIcon aria-hidden />
                    New Campaign
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <div className="mb-4 flex gap-2" aria-label="Campaign workspace">
                  <Button
                    size="sm"
                    variant={workspace === "studio" ? "default" : "outline"}
                    onClick={() => setWorkspace("studio")}
                  >
                    Studio
                  </Button>
                  <Button
                    size="sm"
                    variant={workspace === "posts" ? "default" : "outline"}
                    onClick={() => setWorkspace("posts")}
                  >
                    Posts
                  </Button>
                </div>
                {workspace === "studio" ? (
                  postsReady && board.studio?.campaignId === campaign.id ? (
                    <CampaignStudio
                      key={`${environmentId}:${campaign.id}`}
                      studio={board.studio}
                      campaignName={campaign.name}
                      campaigns={board.campaigns}
                      brandNotes={client?.brandNotes ?? ""}
                      environmentId={environmentId}
                      generation={board.generation}
                      posts={posts}
                      isAdministrator={isAdministrator}
                      run={run}
                      refresh={refresh}
                      onOpenPost={setPostId}
                      onNewPost={() => {
                        setPrefill(null);
                        setPostId("new");
                      }}
                    />
                  ) : (
                    <p role="status" className="text-sm text-muted-foreground">
                      {postsReady
                        ? "Content Studio is unavailable on this server. Your campaign posts are available in Posts."
                        : "Loading Content Studio…"}
                    </p>
                  )
                ) : (
                  <CampaignBoardPanel
                    environmentId={environmentId}
                    board={board}
                    campaign={campaign}
                    client={client}
                    posts={posts}
                    postsReady={postsReady}
                    isAdministrator={isAdministrator}
                    run={run}
                    onOpenPost={setPostId}
                    onNewPost={() => {
                      setPrefill(null);
                      setPostId("new");
                    }}
                    onGenerate={() => {
                      setVideoFrom(null);
                      setGenerating(true);
                    }}
                    onMakeVideo={(job: CampaignGenerationJob) => {
                      setVideoFrom(job);
                      setGenerating(true);
                    }}
                    onTemplates={(initial) => setTemplates({ initial })}
                    onAddToPost={(job: CampaignGenerationJob) => {
                      // A job made for another of this client's campaigns opens that campaign, so the
                      // new post lands where the job was made.
                      if (
                        job.campaignId !== undefined &&
                        job.campaignId !== campaign.id &&
                        board.campaigns.some((candidate) => candidate.id === job.campaignId)
                      ) {
                        setRequested(job.campaignId);
                      }
                      setPrefill({
                        key: job.id,
                        mediaPaths: job.resultPaths,
                        sourceThreadId: job.sourceThreadId,
                      });
                      setPostId("new");
                    }}
                    onRename={() =>
                      setCampaignDialog({ clientId: campaign.clientId, campaignId: campaign.id })
                    }
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      <CampaignClientDialog
        open={clientDialog !== null}
        client={editingClient}
        run={run}
        onClose={() => setClientDialog(null)}
        onSaved={() => undefined}
        onDeleted={(id) => {
          if (campaign?.clientId === id) setRequested(null);
        }}
      />
      <CampaignNameDialog
        open={campaignDialog !== null}
        clientId={campaignDialog?.clientId ?? ""}
        clientName={dialogClient?.name ?? "this client"}
        campaign={editingCampaign}
        run={run}
        onClose={() => setCampaignDialog(null)}
        onSaved={(saved) => {
          setJustCreated(saved);
          setRequested(saved.id);
          setPostId(null);
        }}
        onDeleted={(id) => {
          setJustCreated(null);
          if (campaign?.id === id) setRequested(null);
        }}
      />
      {campaign !== null ? (
        <CampaignPostDialog
          open={postOpen}
          environmentId={environmentId}
          post={post}
          campaign={campaign}
          client={client}
          connection={board.connection}
          storage={board.storage}
          log={board.log}
          isAdministrator={isAdministrator}
          run={run}
          prefill={prefill}
          onClose={() => {
            setPostId(null);
            setPrefill(null);
          }}
          onCreated={(created) => setPostId(created.id)}
        />
      ) : null}
      {campaign !== null && client !== undefined ? (
        <CampaignGenerateDialog
          open={generating}
          environmentId={environmentId}
          generation={board.generation}
          client={client}
          campaign={campaign}
          preferredThreadId={latestPostThread(posts)}
          startFrom={videoFrom}
          run={run}
          onClose={() => {
            setGenerating(false);
            setVideoFrom(null);
          }}
        />
      ) : null}
      {campaign !== null ? (
        <CampaignTemplatesDialog
          open={templates !== null}
          initialTemplate={templates?.initial ?? null}
          campaign={campaign}
          client={client}
          onClose={() => setTemplates(null)}
        />
      ) : null}
    </>
  );
}
