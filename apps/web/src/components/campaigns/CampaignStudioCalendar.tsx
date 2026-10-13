import {
  CAMPAIGN_PLATFORMS,
  CAMPAIGN_PLATFORM_LABELS,
  type CampaignPost,
} from "@t3tools/contracts";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { captionExcerpt } from "./campaigns.logic";
import { studioCalendarPosts } from "./studio.logic";

export function CampaignStudioCalendar({
  posts,
  onOpenPost,
  onNewPost,
}: {
  readonly posts: readonly CampaignPost[];
  readonly onOpenPost: (id: string) => void;
  readonly onNewPost: () => void;
}) {
  const id = useId();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [platform, setPlatform] = useState("all");
  const scheduled = studioCalendarPosts(posts, month, platform);
  const unscheduled = posts.filter(
    (post) =>
      !post.scheduledAt &&
      (platform === "all" || post.platforms.some((value) => value === platform)),
  );
  return (
    <section aria-label="Campaign calendar" className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={`${id}-month`}>Month</Label>
          <Input
            nativeInput
            id={`${id}-month`}
            type="month"
            value={month}
            onChange={(event) => setMonth(event.currentTarget.value)}
          />
        </div>
        <div>
          <Label htmlFor={`${id}-platform`}>Platform</Label>
          <select
            id={`${id}-platform`}
            className="rounded-md border border-input bg-background p-2 text-sm"
            value={platform}
            onChange={(event) => setPlatform(event.currentTarget.value)}
          >
            <option value="all">All platforms</option>
            {CAMPAIGN_PLATFORMS.map((value) => (
              <option key={value} value={value}>
                {CAMPAIGN_PLATFORM_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={onNewPost}>
          New post
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Times shown in {new Intl.DateTimeFormat().resolvedOptions().timeZone}. Open a post to edit
        its caption, platforms or schedule.
      </p>
      {scheduled.length === 0 ? (
        <p className="text-sm text-muted-foreground">No scheduled posts this month.</p>
      ) : (
        <ul className="divide-y divide-border">
          {scheduled.map((post) => (
            <li key={post.id} className="py-3">
              <button
                type="button"
                className="w-full space-y-1 text-left"
                onClick={() => onOpenPost(post.id)}
              >
                <p className="text-sm font-medium">
                  {new Date(post.scheduledAt!).toLocaleString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}{" "}
                  · {post.title || captionExcerpt(post) || "Untitled post"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {post.platforms.map((value) => CAMPAIGN_PLATFORM_LABELS[value]).join(" · ")} ·{" "}
                  {post.status}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-sm font-medium">Unscheduled ({unscheduled.length})</h3>
      <ul className="space-y-2">
        {unscheduled.map((post) => (
          <li key={post.id}>
            <Button variant="ghost" size="sm" onClick={() => onOpenPost(post.id)}>
              {post.title || captionExcerpt(post) || "Untitled post"} · {post.status}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
