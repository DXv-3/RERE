import type { CampaignPlatform } from "@t3tools/contracts";
import { MEDIA_VIDEO_EXTENSIONS } from "@t3tools/contracts";

/** The marketing engine's post types as this connector sends them. */
export type EnginePostType = "text" | "image" | "video" | "reel";

const isVideo = (address: string): boolean => {
  let path = address;
  try {
    path = new URL(address).pathname;
  } catch {
    // A relative path is read as it is.
  }
  const lower = path.toLowerCase();
  return MEDIA_VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/**
 * The engine's `type` for a post going to one platform, from the media it carries: images are
 * "image", video is "video", and video for Instagram or TikTok is a "reel". A post with no media
 * is "text".
 */
// engine post types: confirm against apps/marketing-engine/src/types.ts PostType
export function enginePostType(
  platform: CampaignPlatform,
  mediaUrls: ReadonlyArray<string>,
): EnginePostType {
  if (mediaUrls.length === 0) return "text";
  if (!mediaUrls.some(isVideo)) return "image";
  return platform === "instagram" || platform === "tiktok" ? "reel" : "video";
}
