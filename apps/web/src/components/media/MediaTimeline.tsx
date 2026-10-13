import type { MediaAnnotation, MediaFrame } from "@t3tools/contracts";
import { memo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  formatTimecode,
  formatTimeRange,
  MIN_DRAG_RANGE_SECONDS,
  normalizeRange,
  timeAtTimelineX,
  timelineFraction,
  type TimeRange,
} from "~/lib/mediaReview";
import { cn } from "~/lib/utils";

const DRAG_START_PIXELS = 4;

/** The strip of frames. Memoised: it does not change while the playhead moves. */
const ThumbnailStrip = memo(function ThumbnailStrip(props: {
  readonly frames: ReadonlyArray<MediaFrame> | null;
}) {
  if (props.frames === null || props.frames.length === 0) {
    return <div aria-hidden className="absolute inset-0 bg-muted/60" />;
  }
  return (
    <div aria-hidden className="absolute inset-0 flex overflow-hidden">
      {props.frames.map((frame) => (
        <img
          key={frame.at}
          src={`data:${frame.mimeType};base64,${frame.base64}`}
          alt=""
          draggable={false}
          className="h-full min-w-0 flex-1 select-none object-cover"
        />
      ))}
    </div>
  );
});

/**
 * The timeline: thumbnails, the playhead and the selected range. Click to seek, drag to select
 * a range. Notes show as markers underneath. Frame stepping and Mark In/Out live on the
 * viewer's keyboard handling; this track is the slider those keys act on.
 */
export function MediaTimeline(props: {
  readonly duration: number;
  readonly currentTime: number;
  readonly thumbnails: ReadonlyArray<MediaFrame> | null;
  readonly range: TimeRange | null;
  readonly annotations: ReadonlyArray<MediaAnnotation>;
  readonly onSeek: (time: number) => void;
  readonly onSelectRange: (range: TimeRange | null) => void;
  readonly onJumpToAnnotation: (annotation: MediaAnnotation) => void;
}) {
  const { duration, currentTime, range } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startTime: number; dragging: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    return rect ? timeAtTimelineX(clientX - rect.left, rect.width, duration) : 0;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || duration <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startTime: timeAt(event.clientX), dragging: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < DRAG_START_PIXELS) return;
    if (!drag.dragging) {
      drag.dragging = true;
      setDragging(true);
    }
    props.onSelectRange(normalizeRange(drag.startTime, timeAt(event.clientX), duration));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!drag) return;
    if (!drag.dragging) {
      props.onSeek(drag.startTime);
      return;
    }
    const finished = normalizeRange(drag.startTime, timeAt(event.clientX), duration);
    // A tiny drag is a click with a wobble: seek there and select nothing.
    if (finished.end - finished.start < MIN_DRAG_RANGE_SECONDS) {
      props.onSelectRange(null);
      props.onSeek(drag.startTime);
    }
  };
  const onPointerCancel = () => {
    dragRef.current = null;
    setDragging(false);
  };
  // Home and End jump to the ends; the viewer's own handler takes the arrow and mark keys.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      props.onSeek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      props.onSeek(duration);
    }
  };

  const open = props.annotations.filter((annotation) => annotation.status === "open");
  const playheadLeft = `${timelineFraction(currentTime, duration) * 100}%`;
  return (
    <div className="flex flex-col gap-1">
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, duration)}
        aria-valuenow={Math.min(Math.max(0, currentTime), Math.max(0, duration))}
        aria-valuetext={`${formatTimecode(currentTime)} of ${formatTimecode(duration)}${
          range ? `, selected ${formatTimeRange(range.start, range.end)}` : ""
        }`}
        className={cn(
          "relative h-14 touch-none select-none overflow-hidden rounded-md border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
          dragging ? "cursor-col-resize" : "cursor-pointer",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        <ThumbnailStrip frames={props.thumbnails} />
        {range ? (
          <div
            aria-hidden
            className="absolute inset-y-0 border-x-2 border-primary bg-primary/25"
            style={{
              left: `${timelineFraction(range.start, duration) * 100}%`,
              width: `${Math.max(0.4, (timelineFraction(range.end, duration) - timelineFraction(range.start, duration)) * 100)}%`,
            }}
          />
        ) : null}
        <div
          aria-hidden
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white ring-1 ring-black/60"
          style={{ left: playheadLeft }}
        />
      </div>
      {open.length > 0 ? (
        <ul aria-label="Notes on the timeline" className="relative h-3">
          {open.map((annotation) => {
            if (annotation.timeStart === undefined) return null;
            const left = timelineFraction(annotation.timeStart, duration) * 100;
            const width =
              annotation.timeEnd === undefined
                ? 0
                : (timelineFraction(annotation.timeEnd, duration) -
                    timelineFraction(annotation.timeStart, duration)) *
                  100;
            return (
              <li
                key={annotation.id}
                className="absolute inset-y-0"
                style={{ left: `${left}%`, width: width > 0 ? `${width}%` : undefined }}
              >
                <button
                  type="button"
                  aria-label={`Jump to note at ${formatTimeRange(annotation.timeStart, annotation.timeEnd)}: ${annotation.comment}`}
                  onClick={() => props.onJumpToAnnotation(annotation)}
                  className={cn(
                    "block h-3 cursor-pointer bg-warning outline-none hover:bg-warning/80 focus-visible:ring-2 focus-visible:ring-ring",
                    width > 0 ? "w-full rounded-sm" : "w-2 -translate-x-1/2 rounded-full",
                  )}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
