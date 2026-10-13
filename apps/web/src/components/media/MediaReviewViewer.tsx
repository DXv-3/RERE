import type {
  EnvironmentId,
  MediaAnnotation,
  MediaKind,
  MediaRegionBox,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { sortMediaAnnotations } from "@t3tools/shared/mediaAnnotations";
import {
  BookmarkIcon,
  PauseIcon,
  PlayIcon,
  SquareDashedIcon,
  StepBackIcon,
  StepForwardIcon,
  TriangleAlertIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { mediaAnnotationContextRecord } from "~/lib/composerContextRecords";
import {
  DEFAULT_KEYBOARD_BOX,
  formatTimecode,
  formatTimeRange,
  isAnnotationActiveAt,
  MIN_DRAG_RANGE_SECONDS,
  nextPlaybackRate,
  rangeFromMarks,
  reviewKeyAction,
  stepTime,
  type TimeRange,
} from "~/lib/mediaReview";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { MediaAnnotationList } from "./MediaAnnotationList";
import { MediaRegionLayer } from "./MediaRegionLayer";
import { MediaTimeline } from "./MediaTimeline";
import {
  useMediaAnnotationsSidecar,
  useMediaProbe,
  useMediaThumbnails,
} from "./useMediaReviewData";

/** The playhead is read at most this often while playing: smooth enough, far from a paint loop. */
const PLAYHEAD_UPDATE_MS = 66;

const THUMBNAIL_MIN = 4;
const THUMBNAIL_MAX = 20;

function thumbnailCount(durationSeconds: number | null): number {
  if (durationSeconds === null) return THUMBNAIL_MIN;
  return Math.min(THUMBNAIL_MAX, Math.max(THUMBNAIL_MIN, Math.ceil(durationSeconds / 2)));
}

function Notice(props: { readonly children: string; readonly tone?: "warning" | "neutral" }) {
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        props.tone === "neutral"
          ? "border-border/70 bg-muted/50 text-muted-foreground"
          : "border-warning/32 bg-warning-surface text-warning-foreground",
      )}
    >
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{props.children}</span>
    </p>
  );
}

/**
 * Watch a video or look at an image from the thread's folder, circle part of the picture and/or
 * select a stretch of the timeline, say what should change, and add it to the message. The
 * agent receives the note with frames from that moment, cut by the server with the region drawn
 * on them. Notes are also saved beside the file so the review outlives the message.
 */
export function MediaReviewViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly cwd: string;
  /** Inside `cwd`; the server refuses anything else. */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: MediaKind;
  readonly workspaceMutationId: string | null;
}) {
  const { environmentId, cwd, relativePath, kind, composerDraftTarget } = props;
  const isVideo = kind === "video";
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const probeState = useMediaProbe({
    environmentId,
    cwd,
    relativePath,
    revision: props.workspaceMutationId,
  });
  const probe = probeState.status === "ready" ? probeState.probe : null;
  // A change to the file itself (not any change in the workspace) is what reloads the picture.
  const fileKey = probe
    ? `${probe.sizeBytes}:${probe.durationSeconds ?? 0}:${probe.width}x${probe.height}`
    : null;

  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.absolutePath, props.threadRef.threadId],
  );
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  // The picture starts loading at once; it only reloads if the file itself changes on disk.
  const [reloadToken, setReloadToken] = useState(0);
  const lastFileKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (fileKey === null) return;
    if (lastFileKeyRef.current !== null && lastFileKeyRef.current !== fileKey) {
      setReloadToken((token) => token + 1);
    }
    lastFileKeyRef.current = fileKey;
  }, [fileKey]);
  const latestUrl =
    assetUrl._tag === "Success"
      ? reloadToken === 0
        ? assetUrl.url
        : `${assetUrl.url}${assetUrl.url.includes("?") ? "&" : "?"}v=${reloadToken}`
      : null;

  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  // Re-signed URLs must not restart a video that is playing; the new one is taken once it pauses.
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  useEffect(() => {
    if (latestUrl !== null && (mediaUrl === null || !playing)) setMediaUrl(latestUrl);
  }, [latestUrl, mediaUrl, playing]);

  const duration = probe?.durationSeconds ?? videoDuration ?? 0;
  const mediaSize = probe
    ? { width: probe.width, height: probe.height }
    : (naturalSize ?? { width: 0, height: 0 });

  const thumbnails = useMediaThumbnails({
    environmentId,
    cwd,
    relativePath,
    count: thumbnailCount(probe?.durationSeconds ?? null),
    enabled: isVideo && probe !== null,
    revision: fileKey,
  });

  const sidecar = useMediaAnnotationsSidecar({
    environmentId,
    cwd,
    relativePath,
    revision: props.workspaceMutationId,
  });
  const sortedAnnotations = useMemo(
    () => sortMediaAnnotations(sidecar.annotations),
    [sidecar.annotations],
  );

  const addMediaAnnotation = useComposerDraftStore((store) => store.addMediaAnnotation);
  const removeMediaAnnotation = useComposerDraftStore((store) => store.removeMediaAnnotation);

  // What is being drafted: a region, a range (or marks that make one), and the comment.
  const [box, setBox] = useState<MediaRegionBox | null>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [justAdded, setJustAdded] = useState(false);

  // --- playback --------------------------------------------------------------------------

  const syncTime = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    lastTimeRef.current = video.currentTime;
    setCurrentTime(video.currentTime);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= PLAYHEAD_UPDATE_MS) {
        last = now;
        syncTime();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, syncTime]);

  // A reloaded file keeps its place.
  const lastTimeRef = useRef(0);
  const loadedOnceRef = useRef(false);

  const seek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, time);
      const video = videoRef.current;
      if (video && !mediaFailed) video.currentTime = clamped;
      lastTimeRef.current = clamped;
      setCurrentTime(clamped);
    },
    [mediaFailed],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || mediaFailed) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, [mediaFailed]);

  const step = useCallback(
    (direction: 1 | -1, coarse: boolean) => {
      const video = videoRef.current;
      video?.pause();
      seek(
        stepTime({
          current: video && !mediaFailed ? video.currentTime : currentTime,
          duration,
          fps: probe?.fps ?? null,
          direction,
          coarse,
        }),
      );
    },
    [currentTime, duration, mediaFailed, probe?.fps, seek],
  );

  // --- selection ------------------------------------------------------------------------

  const clearDraft = useCallback(() => {
    setBox(null);
    setRange(null);
    setMarkIn(null);
    setMarkOut(null);
  }, []);

  const mark = useCallback(
    (which: "in" | "out") => {
      const time = videoRef.current && !mediaFailed ? videoRef.current.currentTime : currentTime;
      const nextIn = which === "in" ? time : markIn;
      const nextOut = which === "out" ? time : markOut;
      setMarkIn(nextIn);
      setMarkOut(nextOut);
      setRange(rangeFromMarks({ markIn: nextIn, markOut: nextOut, duration }));
    },
    [currentTime, duration, markIn, markOut, mediaFailed],
  );

  const selectRangeByDrag = useCallback((next: TimeRange | null) => {
    setMarkIn(null);
    setMarkOut(null);
    setRange(next);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = reviewKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: event.target instanceof HTMLElement ? event.target : null,
      },
      isVideo,
    );
    if (!action) return;
    event.preventDefault();
    switch (action.type) {
      case "toggle-play":
        togglePlay();
        break;
      case "step":
        step(action.direction, action.coarse);
        break;
      case "mark-in":
        mark("in");
        break;
      case "mark-out":
        mark("out");
        break;
      case "escape":
        clearDraft();
        break;
    }
  };

  // --- notes ----------------------------------------------------------------------------

  const hasSelection = box !== null || range !== null;
  const canAdd = comment.trim().length > 0;

  const addNote = () => {
    const text = comment.trim();
    if (text.length === 0) return;
    const annotationId = randomUUID();
    // With no range, a video note points at the frame on screen.
    const timeStart = isVideo ? (range?.start ?? currentTime) : undefined;
    const timeEnd =
      isVideo && range && range.end - range.start >= MIN_DRAG_RANGE_SECONDS ? range.end : undefined;
    const note: MediaAnnotation = {
      id: annotationId,
      status: "open",
      comment: text,
      createdAt: new Date().toISOString(),
      ...(timeStart !== undefined ? { timeStart } : {}),
      ...(timeEnd !== undefined ? { timeEnd } : {}),
      ...(box ? { box } : {}),
    };
    sidecar.add(note);
    addMediaAnnotation(
      composerDraftTarget,
      mediaAnnotationContextRecord({
        annotationId,
        filePath: relativePath,
        mediaKind: kind,
        timeStart,
        timeEnd,
        box: box ?? undefined,
        comment: text,
      }),
    );
    clearDraft();
    setComment("");
    setJustAdded(true);
  };

  const removeNote = (id: string) => {
    sidecar.remove(id);
    removeMediaAnnotation(composerDraftTarget, id);
  };

  const jumpToAnnotation = useCallback(
    (annotation: MediaAnnotation) => {
      if (!isVideo || annotation.timeStart === undefined) return;
      videoRef.current?.pause();
      seek(annotation.timeStart);
      rootRef.current?.focus();
    },
    [isVideo, seek],
  );

  const visibleSavedBoxes = useMemo(
    () =>
      sortedAnnotations.flatMap((annotation) =>
        annotation.status === "open" &&
        annotation.box &&
        isAnnotationActiveAt(annotation, currentTime)
          ? [{ id: annotation.id, box: annotation.box }]
          : [],
      ),
    [currentTime, sortedAnnotations],
  );

  const draftSummary = [
    isVideo && range ? `Range ${formatTimeRange(range.start, range.end)}` : null,
    isVideo && !range ? `At ${formatTimecode(currentTime)}` : null,
    box ? "Region selected" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  // --- render ---------------------------------------------------------------------------

  const stageContent =
    assetUrl._tag === "Failure" ? (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-destructive text-xs">
        <span>Unable to load this file.</span>
        <Button size="sm" variant="secondary" onClick={() => void refreshAssetUrl()}>
          Retry
        </Button>
      </div>
    ) : mediaUrl === null ? (
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <Spinner size="lg" />
      </div>
    ) : isVideo ? (
      <video
        ref={videoRef}
        src={mediaUrl}
        aria-label={`Video ${relativePath}`}
        playsInline
        preload="metadata"
        muted={muted}
        className="absolute inset-0 size-full bg-black object-contain"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setVideoDuration(Number.isFinite(video.duration) ? video.duration : null);
          setNaturalSize({ width: video.videoWidth, height: video.videoHeight });
          setMediaFailed(false);
          if (loadedOnceRef.current && lastTimeRef.current > 0) {
            video.currentTime = lastTimeRef.current;
          }
          loadedOnceRef.current = true;
          video.playbackRate = rate;
        }}
        onTimeUpdate={syncTime}
        onSeeked={syncTime}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          syncTime();
        }}
        onEnded={() => {
          setPlaying(false);
          syncTime();
        }}
        onError={() => setMediaFailed(true)}
      />
    ) : (
      <img
        src={mediaUrl}
        alt={relativePath}
        draggable={false}
        className="absolute inset-0 size-full select-none object-contain"
        onLoad={(event) =>
          setNaturalSize({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
        onError={() => setMediaFailed(true)}
      />
    );

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={`Review ${relativePath}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 outline-none"
    >
      {probeState.status === "error" ? (
        <Notice>
          {probeState.reason === "tool_missing"
            ? `${probeState.message} The ${isVideo ? "video still plays, but timeline thumbnails and" : "image still shows, but"} frames for the agent need it.`
            : `${probeState.message} You can still look at the file; notes may be sent without frames.`}
        </Notice>
      ) : null}
      {sidecar.notice ? <Notice tone="neutral">{sidecar.notice}</Notice> : null}

      <div className="relative h-[clamp(12rem,45vh,34rem)] shrink-0 overflow-hidden rounded-md border border-border bg-black">
        {stageContent}
        {mediaFailed && mediaUrl !== null ? (
          <div
            role="alert"
            className="absolute inset-0 flex items-center justify-center bg-black/80 px-6 text-center text-white text-xs"
          >
            {isVideo
              ? "This browser cannot play this video. You can still select a range on the timeline and add notes; the agent's frames come from the server."
              : "This browser cannot show this image. You can still add notes; the agent's frames come from the server."}
          </div>
        ) : null}
        {mediaUrl !== null && !mediaFailed && mediaSize.width > 0 ? (
          <MediaRegionLayer
            media={mediaSize}
            box={box}
            onBoxChange={setBox}
            savedBoxes={visibleSavedBoxes}
            onTap={isVideo ? togglePlay : undefined}
          />
        ) : null}
      </div>

      {isVideo ? (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={playing ? "Pause" : "Play"}
              disabled={mediaFailed || mediaUrl === null}
              onClick={togglePlay}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Previous frame"
              disabled={mediaFailed}
              onClick={() => step(-1, false)}
            >
              <StepBackIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Next frame"
              disabled={mediaFailed}
              onClick={() => step(1, false)}
            >
              <StepForwardIcon />
            </Button>
            <span
              className="px-1 font-mono text-muted-foreground text-xs tabular-nums"
              aria-label={`Position ${formatTimecode(currentTime)} of ${formatTimecode(duration)}`}
            >
              {formatTimecode(currentTime)} / {formatTimecode(duration)}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button
                size="compact"
                variant="ghost-muted"
                aria-label={`Playback speed ${rate}x. Change speed.`}
                disabled={mediaFailed}
                onClick={() => {
                  const next = nextPlaybackRate(rate);
                  setRate(next);
                  if (videoRef.current) videoRef.current.playbackRate = next;
                }}
              >
                {rate}x
              </Button>
              {probe?.hasAudio ? (
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={muted ? "Unmute" : "Mute"}
                  aria-pressed={muted}
                  onClick={() => setMuted((current) => !current)}
                >
                  {muted ? <VolumeXIcon /> : <Volume2Icon />}
                </Button>
              ) : null}
            </span>
          </div>
          <MediaTimeline
            duration={duration}
            currentTime={currentTime}
            thumbnails={thumbnails}
            range={range}
            annotations={sortedAnnotations}
            onSeek={seek}
            onSelectRange={selectRangeByDrag}
            onJumpToAnnotation={jumpToAnnotation}
          />
        </>
      ) : null}

      <section aria-label="Add a note" className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="compact"
            variant="outline"
            aria-pressed={box !== null}
            onClick={() => setBox((current) => (current ? null : DEFAULT_KEYBOARD_BOX))}
          >
            <SquareDashedIcon />
            {box ? "Clear region" : "Select region"}
          </Button>
          {isVideo ? (
            <>
              <Button
                size="compact"
                variant="outline"
                aria-label="Mark in at the playhead (I)"
                onClick={() => mark("in")}
              >
                <BookmarkIcon />
                Mark in
              </Button>
              <Button
                size="compact"
                variant="outline"
                aria-label="Mark out at the playhead (O)"
                onClick={() => mark("out")}
              >
                <BookmarkIcon />
                Mark out
              </Button>
            </>
          ) : null}
          {hasSelection ? (
            <Button size="compact" variant="ghost-muted" onClick={clearDraft}>
              <XIcon />
              Clear
            </Button>
          ) : null}
          <span className="ml-auto text-muted-foreground text-xs">{draftSummary}</span>
        </div>
        <Textarea
          aria-label="What should change here?"
          placeholder="What should change here?"
          size="sm"
          value={comment}
          onChange={(event) => {
            setComment(event.target.value);
            setJustAdded(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canAdd) {
              event.preventDefault();
              addNote();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span aria-live="polite" className="text-muted-foreground text-xs">
            {justAdded ? "Added to your message." : ""}
          </span>
          <Button size="sm" disabled={!canAdd} onClick={addNote}>
            Add to message
          </Button>
        </div>
      </section>

      <MediaAnnotationList
        annotations={sortedAnnotations}
        onJump={jumpToAnnotation}
        onSetStatus={sidecar.setStatus}
        onRemove={removeNote}
      />
    </div>
  );
}
