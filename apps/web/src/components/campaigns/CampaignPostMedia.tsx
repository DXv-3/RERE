import { ThreadId, type CampaignPost, type EnvironmentId } from "@t3tools/contracts";
import { FileIcon, FilmIcon, ImageIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useOpenThread } from "../workbench/useOpenThread";
import { isImageName, isVideoName } from "./campaigns.logic";
import { useVideoThumbnail } from "./useVideoThumbnail";

export interface PostMediaItem {
  readonly kind: "path" | "url";
  readonly value: string;
}

/** Every file of a post, folder paths first, in the order they were added. */
export function postMediaItems(
  post: Pick<CampaignPost, "mediaPaths" | "mediaUrls">,
): PostMediaItem[] {
  return [
    ...post.mediaPaths.map((value) => ({ kind: "path" as const, value })),
    ...post.mediaUrls.map((value) => ({ kind: "url" as const, value })),
  ];
}

export const mediaDisplayName = (item: PostMediaItem): string => {
  if (item.kind === "path") return item.value.split(/[\\/]/).at(-1) ?? item.value;
  try {
    return new URL(item.value).pathname.split("/").findLast((part) => part !== "") ?? item.value;
  } catch {
    return item.value;
  }
};

/**
 * A small picture for one file. Images from the thread's folder come through the same asset path
 * the file panel uses, and linked images load from their link. A video from the thread's folder
 * shows a real frame once the server has cut one (the folder comes from the thread, and the frame
 * is kept per file); until then, and for anything that cannot be read, it shows an icon.
 */
export function CampaignMediaThumb({
  environmentId,
  sourceThreadId,
  item,
  kind,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: string | undefined;
  readonly item: PostMediaItem | undefined;
  /** What an empty tile stands for, when there is no file yet (a job still being made). */
  readonly kind?: "image" | "video";
  readonly className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const name = item === undefined ? "" : mediaDisplayName(item);
  const folderImage =
    item !== undefined &&
    item.kind === "path" &&
    sourceThreadId !== undefined &&
    isImageName(item.value);
  const asset = useAssetUrlState(
    environmentId,
    folderImage
      ? { _tag: "media-file", threadId: ThreadId.make(sourceThreadId), path: item.value }
      : null,
  );
  const videoPath =
    item !== undefined && item.kind === "path" && isVideoName(item.value) ? item.value : null;
  const frame = useVideoThumbnail({ environmentId, sourceThreadId, relativePath: videoPath });
  const src =
    item === undefined || broken
      ? null
      : item.kind === "url"
        ? isImageName(item.value)
          ? item.value
          : null
        : videoPath !== null
          ? frame
          : asset._tag === "Success"
            ? asset.url
            : null;

  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground ${className ?? "size-14"}`}
    >
      {src !== null ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : isVideoName(name) || (item === undefined && kind === "video") ? (
        <FilmIcon className="size-5" />
      ) : isImageName(name) || (item === undefined && kind === "image") ? (
        <ImageIcon className="size-5" />
      ) : (
        <FileIcon className="size-5" />
      )}
    </span>
  );
}

/**
 * Opens a post's file from its thread's folder in the media viewer: the thread opens with the
 * file in its right panel, where it can be played and annotated like any other media. A post with
 * no thread has no folder to open from.
 */
export function useOpenPostMedia(environmentId: EnvironmentId) {
  const openThread = useOpenThread(environmentId);
  return useCallback(
    (sourceThreadId: string, path: string) => openThread(sourceThreadId, { file: path }),
    [openThread],
  );
}
