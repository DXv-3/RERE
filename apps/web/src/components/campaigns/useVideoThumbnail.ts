import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo, useState } from "react";

import { useProject, useThreadShell } from "../../state/entities";
import { mediaEnvironment } from "../../state/media";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createThumbnailCache,
  frameDataUrl,
  thumbnailKey,
  type ThumbnailEntry,
} from "./mediaThumbnail.logic";

/**
 * The folder a thread works in: its own checkout when it has one, else its project's folder. The
 * media calls take this folder and a path inside it. Null while the thread is unknown or not
 * loaded, so nothing is asked of the server until the folder is known.
 */
function useThreadFolder(
  environmentId: EnvironmentId,
  threadId: string | undefined,
): string | null {
  const threadRef = useMemo(
    () => (threadId === undefined ? null : scopeThreadRef(environmentId, ThreadId.make(threadId))),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(environmentId, shell.projectId),
  );
  return shell === null ? null : (shell.worktreePath ?? project?.workspaceRoot ?? null);
}

// Shared by every card, so a file is asked about once however often the board redraws.
const cache = createThumbnailCache();
const inFlight = new Map<string, Promise<ThumbnailEntry>>();
const MAX_AT_ONCE = 2;
let active = 0;
const waiting: Array<() => void> = [];

/** At most two frame cuts at a time, so a board of reels does not start a dozen tools at once. */
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * A real frame from a video in a thread's folder, or null while it is loading, when the folder is
 * not known, or when no frame could be cut (the caller keeps its icon). It never blocks the card:
 * the answer arrives later and is kept per file, so later board updates reuse it.
 */
export function useVideoThumbnail(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: string | undefined;
  /** The file's path inside the thread's folder, or null for anything that is not such a video. */
  readonly relativePath: string | null;
}): string | null {
  const { environmentId, sourceThreadId, relativePath } = input;
  const cwd = useThreadFolder(environmentId, relativePath === null ? undefined : sourceThreadId);
  const thumbnails = useAtomCommand(mediaEnvironment.thumbnails, { reportFailure: false });
  const key =
    cwd === null || relativePath === null
      ? null
      : thumbnailKey({ environmentId, cwd, relativePath });
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly src: string } | null>(null);

  useEffect(() => {
    if (key === null || cwd === null || relativePath === null) return;
    // A frame already cut is read while rendering; a recent failure is left alone.
    if (cache.get(key, Date.now()) !== undefined) return;
    let cancelled = false;
    let request = inFlight.get(key);
    if (request === undefined) {
      request = withSlot(async (): Promise<ThumbnailEntry> => {
        const result = await thumbnails({ environmentId, input: { cwd, relativePath, count: 1 } });
        const frame = result._tag === "Success" ? result.value.frames[0] : undefined;
        if (frame === undefined) {
          cache.setFailed(key, Date.now());
          return { state: "failed", at: Date.now() };
        }
        const src = frameDataUrl(frame);
        cache.setReady(key, src);
        return { state: "ready", src };
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, request);
    }
    void request.then((entry) => {
      if (!cancelled && entry.state === "ready") setLoaded({ key, src: entry.src });
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, environmentId, key, relativePath, thumbnails]);

  if (key === null) return null;
  // `now` of 0 only matters for failures, which show nothing either way.
  const kept = cache.get(key, 0);
  if (kept?.state === "ready") return kept.src;
  return loaded !== null && loaded.key === key ? loaded.src : null;
}
