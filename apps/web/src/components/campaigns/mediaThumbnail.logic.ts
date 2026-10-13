/**
 * A small cache for video still frames on the board. A card is redrawn every time the board
 * changes, and cutting a frame asks the server to run a tool, so the answer for a file is kept: a
 * frame for a good while, a failure for a short while so a missing tool is not asked about again on
 * every update. Pure, so the keying and the retry rule are tested without a screen.
 */

/** A file is the same file only in the same folder on the same environment. */
export const thumbnailKey = (input: {
  readonly environmentId: string;
  readonly cwd: string;
  readonly relativePath: string;
}): string => JSON.stringify([input.environmentId, input.cwd, input.relativePath]);

/** How long a failed attempt is remembered before the file may be tried again. */
const THUMBNAIL_RETRY_AFTER_MS = 2 * 60_000;
const THUMBNAIL_CACHE_LIMIT = 200;

export type ThumbnailEntry =
  | { readonly state: "ready"; readonly src: string }
  | { readonly state: "failed"; readonly at: number };

export interface ThumbnailCache {
  readonly get: (key: string, now: number) => ThumbnailEntry | undefined;
  readonly setReady: (key: string, src: string) => void;
  readonly setFailed: (key: string, now: number) => void;
  readonly size: () => number;
}

/** Oldest-first eviction at `limit`, and a failure that expires after `retryAfterMs`. */
export function createThumbnailCache(
  limit: number = THUMBNAIL_CACHE_LIMIT,
  retryAfterMs: number = THUMBNAIL_RETRY_AFTER_MS,
): ThumbnailCache {
  const entries = new Map<string, ThumbnailEntry>();
  const put = (key: string, entry: ThumbnailEntry) => {
    // Re-inserting moves it to the newest end.
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };
  return {
    get: (key, now) => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.state === "failed" && now - entry.at >= retryAfterMs) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    setReady: (key, src) => put(key, { state: "ready", src }),
    setFailed: (key, now) => put(key, { state: "failed", at: now }),
    size: () => entries.size,
  };
}

/** A frame as an address an image can show. */
export const frameDataUrl = (frame: {
  readonly mimeType: string;
  readonly base64: string;
}): string => `data:${frame.mimeType};base64,${frame.base64}`;
