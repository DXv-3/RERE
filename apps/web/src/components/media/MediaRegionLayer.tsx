import type { MediaRegionBox } from "@t3tools/contracts";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  BOX_HANDLES,
  boxFromPoints,
  boxToPixels,
  containedContentBox,
  dragBox,
  isMeaningfulBox,
  isPointOnContent,
  pointerToMediaFraction,
  type BoxHandle,
  type PixelRect,
  type Point,
  type Size,
} from "~/lib/mediaReview";
import { cn } from "~/lib/utils";

const DRAG_START_PIXELS = 4;

const HANDLE_POSITION: Record<Exclude<BoxHandle, "move">, string> = {
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  ne: "left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  e: "left-full top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
  se: "left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
  s: "left-1/2 top-full -translate-x-1/2 -translate-y-1/2 cursor-ns-resize",
  sw: "left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize",
};

const HANDLE_LABEL: Record<Exclude<BoxHandle, "move">, string> = {
  nw: "top left corner",
  n: "top edge",
  ne: "top right corner",
  e: "right edge",
  se: "bottom right corner",
  s: "bottom edge",
  sw: "bottom left corner",
  w: "left edge",
};

type Gesture =
  | { kind: "draw"; origin: Point; originPixels: Point; moved: boolean }
  | { kind: "adjust"; handle: BoxHandle; start: MediaRegionBox; origin: Point };

/**
 * The layer over the picture: drag to circle a region, drag its handles to adjust, and see the
 * outlines of notes already added. It sits exactly over the media element (which fits its
 * picture with `object-fit: contain`), and every box is stored as fractions of the picture
 * itself, never of this layer, so letterbox bars do not skew it.
 */
export function MediaRegionLayer(props: {
  readonly media: Size;
  readonly box: MediaRegionBox | null;
  readonly onBoxChange: (box: MediaRegionBox | null) => void;
  /** Outlines of notes whose time includes the playhead. */
  readonly savedBoxes: ReadonlyArray<{ readonly id: string; readonly box: MediaRegionBox }>;
  /** A click that was not a drag, for toggling playback on a video. */
  readonly onTap?: (() => void) | undefined;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const measure = () =>
      setContainer({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const content: PixelRect = containedContentBox(container, props.media);

  const local = (event: PointerEvent): Point => {
    const rect = layerRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const point = local(event);
    // A press on a letterbox bar is not on the picture: no box starts there.
    if (!isPointOnContent(point, content)) return;
    const fraction = pointerToMediaFraction(point, content);
    if (!fraction) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { kind: "draw", origin: fraction, originPixels: point, moved: false };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = local(event);
    const fraction = pointerToMediaFraction(point, content);
    if (!fraction) return;
    if (gesture.kind === "draw") {
      if (
        !gesture.moved &&
        Math.hypot(point.x - gesture.originPixels.x, point.y - gesture.originPixels.y) <
          DRAG_START_PIXELS
      ) {
        return;
      }
      gesture.moved = true;
      props.onBoxChange(boxFromPoints(gesture.origin, fraction));
      return;
    }
    props.onBoxChange(
      dragBox(gesture.start, gesture.handle, {
        x: fraction.x - gesture.origin.x,
        y: fraction.y - gesture.origin.y,
      }),
    );
  };

  const finish = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    if (gesture.kind === "draw") {
      if (!gesture.moved) {
        props.onTap?.();
        return;
      }
      // A box too small to mean anything is dropped rather than kept as a speck.
      if (props.box && !isMeaningfulBox(props.box)) props.onBoxChange(null);
    }
  };

  const startAdjust = (event: PointerEvent<HTMLElement>, handle: BoxHandle) => {
    if (event.button !== 0 || !props.box) return;
    event.stopPropagation();
    const fraction = pointerToMediaFraction(local(event), content);
    if (!fraction) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = { kind: "adjust", handle, start: props.box, origin: fraction };
  };

  // Keyboard path for the same box: arrows move it, Shift with arrows resizes it.
  const onBoxKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const box = props.box;
    if (!box) return;
    const step = event.altKey ? 0.002 : 0.01;
    const delta: Point | null =
      event.key === "ArrowLeft"
        ? { x: -step, y: 0 }
        : event.key === "ArrowRight"
          ? { x: step, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -step }
            : event.key === "ArrowDown"
              ? { x: 0, y: step }
              : null;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    props.onBoxChange(dragBox(box, event.shiftKey ? "se" : "move", delta));
  };

  const pending = props.box ? boxToPixels(props.box, content) : null;
  return (
    <div
      ref={layerRef}
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => {
        gestureRef.current = null;
      }}
    >
      {props.savedBoxes.map((saved) => {
        const rect = boxToPixels(saved.box, content);
        return (
          <div
            key={saved.id}
            aria-hidden
            className="pointer-events-none absolute border-2 border-dashed border-warning ring-1 ring-black/55"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          />
        );
      })}
      {pending ? (
        <div
          role="group"
          tabIndex={0}
          aria-label="Selected region. Arrow keys move it, Shift with arrow keys resizes it, Escape clears it."
          onKeyDown={onBoxKeyDown}
          className="absolute border-2 border-destructive ring-1 ring-white/80 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ left: pending.x, top: pending.y, width: pending.width, height: pending.height }}
        >
          <div
            aria-hidden
            className="absolute inset-0 cursor-move"
            onPointerDown={(event) => startAdjust(event, "move")}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
          />
          {BOX_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              aria-label={`Resize region, ${HANDLE_LABEL[handle]}`}
              tabIndex={-1}
              className={cn(
                "absolute size-3 rounded-xs border border-destructive bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring",
                HANDLE_POSITION[handle],
              )}
              onPointerDown={(event) => startAdjust(event, handle)}
              onPointerMove={onPointerMove}
              onPointerUp={finish}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
