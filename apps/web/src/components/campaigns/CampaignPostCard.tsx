import {
  CAMPAIGN_PLATFORM_LABELS,
  type CampaignPlatform,
  type CampaignPost,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AlertTriangleIcon } from "lucide-react";

import { CampaignMediaThumb, postMediaItems } from "./CampaignPostMedia";
import { POST_STATUS_LABEL, cardSummary, cardSummaryLine } from "./campaigns.logic";

/** The first platform that failed and why, for a post that did not go out. */
function firstFailure(post: CampaignPost): string | null {
  for (const [platform, result] of Object.entries(post.publishResults)) {
    if (!result.success) {
      const name = CAMPAIGN_PLATFORM_LABELS[platform as CampaignPlatform] ?? platform;
      return `${name}: ${result.error ?? "It did not go out."}`;
    }
  }
  return null;
}

/**
 * One post on the board: its first picture, the opening of its caption, where and when it goes,
 * who made it and who approved it. The whole card opens the post.
 */
export function CampaignPostCard({
  environmentId,
  post,
  now,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly post: CampaignPost;
  readonly now: Date;
  readonly onOpen: () => void;
}) {
  const summary = cardSummary(post, now);
  const failure = post.status === "failed" ? firstFailure(post) : null;
  return (
    <button type="button" data-wb-cp-card="" data-wb-cp-status={post.status} onClick={onOpen}>
      <CampaignMediaThumb
        environmentId={environmentId}
        sourceThreadId={post.sourceThreadId}
        item={postMediaItems(post)[0]}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm font-medium break-words">
          {summary.caption || "No caption yet"}
        </span>
        <span className="text-xs text-muted-foreground">{cardSummaryLine(summary)}</span>
        {failure ? (
          <span className="flex items-start gap-1 text-xs text-destructive-foreground">
            <AlertTriangleIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">{failure}</span>
          </span>
        ) : null}
        <span className="text-2xs text-muted-foreground">
          {post.status === "publishing" ? "Sending now · " : ""}
          {summary.creator}
          {summary.approval ? ` · ${summary.approval}` : ""}
        </span>
        <span className="sr-only">Status: {POST_STATUS_LABEL[post.status]}</span>
      </span>
    </button>
  );
}
