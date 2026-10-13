import type {
  Campaign,
  CampaignBoard,
  CampaignClient,
  CampaignGenerationJob,
  CampaignPost,
  CampaignSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { LayoutTemplateIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { CampaignGenerationsStrip } from "./CampaignGenerationsStrip";
import { CampaignModeControl } from "./CampaignModeControl";
import { CampaignPostCard } from "./CampaignPostCard";
import { CAMPAIGN_TEMPLATES, type TemplateId } from "./campaignTemplates.logic";
import { draftRequestText, groupPostsByColumn, modeInForce } from "./campaigns.logic";
import type { CampaignRun } from "./useCampaigns";

/** What the publishing setup means for approved posts, in words. */
function PublishingNotes({ connection }: { readonly connection: CampaignBoard["connection"] }) {
  const notes = [
    connection.publishing === "off"
      ? "Publishing is switched off. Approved posts wait here until it is turned on in Settings."
      : null,
    connection.connector === "export"
      ? "Approved posts are saved as folders to post by hand."
      : null,
  ].filter((note): note is string => note !== null);
  if (notes.length === 0) return null;
  return (
    <div
      role="note"
      className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {notes.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </div>
  );
}

/**
 * The chosen campaign as a board: the mode in force, what publishing will do, and a column per
 * stage. Rejected posts sit in a folded group below, out of the way.
 */
export function CampaignBoardPanel({
  environmentId,
  board,
  campaign,
  client,
  posts,
  postsReady,
  isAdministrator,
  run,
  onOpenPost,
  onNewPost,
  onRename,
  onGenerate,
  onAddToPost,
  onMakeVideo,
  onTemplates,
}: {
  readonly environmentId: EnvironmentId;
  readonly board: CampaignBoard;
  readonly campaign: CampaignSummary;
  readonly client: CampaignClient | undefined;
  readonly posts: ReadonlyArray<CampaignPost>;
  readonly postsReady: boolean;
  readonly isAdministrator: boolean;
  readonly run: CampaignRun;
  readonly onOpenPost: (postId: string) => void;
  readonly onNewPost: () => void;
  readonly onRename: () => void;
  readonly onGenerate: () => void;
  readonly onAddToPost: (job: CampaignGenerationJob) => void;
  readonly onMakeVideo: (job: CampaignGenerationJob) => void;
  /** Opens the templates, on the list or straight to one. */
  readonly onTemplates: (template: TemplateId | null) => void;
}) {
  const minute = useNowMinute();
  const now = useMemo(() => new Date(`${minute}:00Z`), [minute]);
  const groups = useMemo(() => groupPostsByColumn(posts), [posts]);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const inForce = modeInForce(client, campaign);
  const clientName = client?.name ?? "this client";
  const empty = postsReady && posts.length === 0;

  const changeMode = async (mode: Campaign["approvalMode"] | null) => {
    const outcome = await run({
      command: "campaign.upsert",
      campaign: {
        id: campaign.id,
        clientId: campaign.clientId,
        name: campaign.name,
        approvalMode: mode,
      },
    });
    return outcome.ok ? null : outcome.message;
  };

  return (
    <section aria-label={`${campaign.name} board`} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold" data-wb-cp-title="">
            {campaign.name}
          </h3>
          <span className="text-xs text-muted-foreground">{clientName}</span>
          <span className="ms-auto flex items-center gap-2">
            {isAdministrator ? (
              <Button size="sm" variant="ghost-muted" onClick={onRename}>
                <PencilIcon aria-hidden />
                Edit Campaign
              </Button>
            ) : null}
            <Button size="sm" variant="ghost-muted" onClick={() => onTemplates(null)}>
              <LayoutTemplateIcon aria-hidden />
              Templates
            </Button>
            <Button size="sm" variant="outline" onClick={onNewPost}>
              <PlusIcon aria-hidden />
              New Post
            </Button>
          </span>
        </div>
        <CampaignModeControl
          scope={{ kind: "campaign", name: campaign.name }}
          mode={inForce.mode}
          overridden={inForce.overridden}
          {...(client === undefined ? {} : { inheritedMode: client.approvalMode })}
          isAdministrator={isAdministrator}
          onChange={changeMode}
        />
        <PublishingNotes connection={board.connection} />
      </header>

      {!postsReady ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" />
          Loading Posts…
        </p>
      ) : null}

      {empty ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-4 py-5">
          <p className="text-sm font-medium">No Posts Yet</p>
          <p className="text-xs text-muted-foreground">
            Ask an agent to draft posts for this campaign. Say which client and campaign, and its
            drafts appear here for you to review.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                copyToClipboard(draftRequestText(clientName, campaign.name), undefined)
              }
            >
              {isCopied ? "Copied" : "Copy A Request For An Agent"}
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={onNewPost}>
              Or Write A Post Yourself
            </Button>
          </div>
          <div className="flex flex-col gap-1.5 pt-1">
            <p className="text-xs font-medium">Or Start From A Template</p>
            <div className="flex flex-wrap gap-2">
              {CAMPAIGN_TEMPLATES.map((template) => (
                <Button
                  key={template.id}
                  size="sm"
                  variant="outline"
                  onClick={() => onTemplates(template.id)}
                >
                  {template.title}
                </Button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {postsReady && !empty ? (
        <div
          className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
          data-wb-cp-columns=""
        >
          {groups.columns.map((column) => (
            <section
              key={column.status}
              aria-label={`${column.label}, ${column.posts.length} ${column.posts.length === 1 ? "post" : "posts"}`}
              className="flex min-w-0 flex-col gap-2"
            >
              <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                {column.label}
                <span className="rounded-full bg-muted px-1.5 text-2xs text-foreground">
                  {column.posts.length}
                </span>
              </h4>
              {column.posts.length === 0 ? (
                <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-2xs text-muted-foreground">
                  Nothing here
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {column.posts.map((post) => (
                    <li key={post.id}>
                      <CampaignPostCard
                        environmentId={environmentId}
                        post={post}
                        now={now}
                        onOpen={() => onOpenPost(post.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : null}

      {groups.rejected.length > 0 ? (
        <details data-wb-cp-rejected="" className="group">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Rejected ({groups.rejected.length})
          </summary>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {groups.rejected.map((post) => (
              <li key={post.id}>
                <CampaignPostCard
                  environmentId={environmentId}
                  post={post}
                  now={now}
                  onOpen={() => onOpenPost(post.id)}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <CampaignGenerationsStrip
        environmentId={environmentId}
        generation={board.generation}
        client={client}
        isAdministrator={isAdministrator}
        run={run}
        onGenerate={onGenerate}
        onAddToPost={onAddToPost}
        onMakeVideo={onMakeVideo}
      />

      {!isAdministrator && posts.some((post) => post.status === "needs-approval") ? (
        <Alert variant="info">
          <AlertDescription>
            Posts waiting for approval need an administrator to approve them.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
