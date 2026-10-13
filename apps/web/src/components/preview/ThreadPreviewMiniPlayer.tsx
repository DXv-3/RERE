"use client";

import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { GripHorizontalIcon, PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useChatCanvas } from "../chat/ChatCanvasContext";
import { BrowserSurfaceSlot, requestBrowserSurfaceRelayout } from "~/browser/BrowserSurfaceSlot";
import {
  findActiveBrowserRecordingRuntimeTabId,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import {
  type PreviewMiniPlayerPosition,
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerSource,
  type PreviewMiniPlayerState,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { writeStoredMiniPlayerPosition } from "~/previewMiniPlayerPositionStorage";
import { useRightPanelStore } from "~/rightPanelStore";
import { useDeviceState } from "~/state/device";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { previewBridge } from "./previewBridge";
import {
  NO_PREVIEW_MINI_PLAYER_OBSTACLES,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_STRIP_HEIGHT,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolvePreviewMiniPlayerContentBox,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerSourceSize,
} from "./previewMiniPlayerLayout";
import { dragMiniPlayerPosition, keyboardMiniPlayerPosition } from "./previewMiniPlayerPlacement";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection;
}

/**
 * A move in progress. The frame follows the pointer through a CSS transform and
 * the store hears about it once, on release, so a drag does not re-render chat.
 */
interface MoveGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  next: PreviewMiniPlayerPosition;
  frameRequest: number | null;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
}

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

const contentBoxStyle = (frame: PreviewMiniPlayerSize) => {
  const box = resolvePreviewMiniPlayerContentBox(frame);
  return { left: box.x, top: box.y, width: box.width, height: box.height };
};

// Invisible grab zones straddling each edge; the cursor is the only affordance.
const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

/** Floats the thread's browser tab or device stream over chat. */
export function ThreadPreviewMiniPlayer({ threadRef, miniPlayer }: Props) {
  const { source } = miniPlayer;
  return source.kind === "browser" ? (
    <BrowserMiniPlayer
      key={source.tabId}
      threadRef={threadRef}
      tabId={source.tabId}
      miniPlayer={miniPlayer}
    />
  ) : (
    <DeviceMiniPlayer
      key={previewMiniPlayerSourceKey(source)}
      threadRef={threadRef}
      source={source}
      miniPlayer={miniPlayer}
    />
  );
}

function BrowserMiniPlayer({ threadRef, tabId, miniPlayer }: Props & { readonly tabId: string }) {
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const recordingTabIds = useActiveBrowserRecordingTabIds();
  const recording =
    recordingTabIds.has(runtimeTabId) ||
    findActiveBrowserRecordingRuntimeTabId(threadRef, tabId) !== null;
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const fittedSourceContent = useBrowserSurfaceStore(
    (state) => state.byTabId[runtimeTabId]?.fittedSourceContent ?? null,
  );
  const sourceSize = resolvePreviewMiniPlayerSourceSize(
    snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT,
    fittedSourceContent,
    desktopOverlay?.zoomFactor ?? 1,
  );

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  if (!snapshot) return null;

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      label="Floating browser preview"
      title="Browser"
      // Hovering the hosted page never reaches this document, so the idle strip keeps a
      // visible grab line to say where the controls are.
      stripHint={previewBridge !== null}
      recording={recording}
      onOpenInPanel={openInPanel}
      pillActions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={
                  desktopOverlay?.pictureInPicture
                    ? "Close popped-out preview"
                    : "Pop preview into separate window"
                }
                disabled={!desktopOverlay?.hasWebContents}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={toggleNativePictureInPicture}
              />
            }
          >
            <PictureInPicture2 />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {desktopOverlay?.pictureInPicture
              ? "Close separate window"
              : "Pop into separate window"}
          </TooltipPopup>
        </Tooltip>
      }
    >
      {(frame) => (
        // The page gets the frame minus the control strip: this box is what the
        // hosted webview is laid over, so nothing of it can cover the strip.
        <div className="absolute" style={contentBoxStyle(frame)}>
          <BrowserSurfaceSlot
            tabId={runtimeTabId}
            visible={Boolean(desktopOverlay?.hasWebContents)}
            cornerRadius={PREVIEW_MINI_PLAYER_CORNER_RADIUS}
            zIndex={PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX}
            fitSourceContent
            layoutVersion={`${frame.x}:${frame.y}`}
            className="absolute inset-0"
          />
          {!desktopOverlay?.hasWebContents ? (
            <div className="pointer-events-none absolute inset-0 z-[49] flex items-center justify-center bg-muted text-xs text-muted-foreground">
              Reconnecting preview…
            </div>
          ) : null}
        </div>
      )}
    </MiniPlayerShell>
  );
}

function DeviceMiniPlayer({
  threadRef,
  source,
  miniPlayer,
}: Props & { readonly source: Extract<PreviewMiniPlayerSource, { kind: "device" }> }) {
  const { state: deviceState } = useDeviceState(threadRef.environmentId);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const sourceSize = resolveDeviceMiniPlayerSourceSize(source.platform, screen);
  const device = deviceState.devices.find(
    (entry) => entry.hostId === source.hostId && entry.id === source.deviceId,
  );
  const hostLabel =
    deviceState.hosts.find((host) => host.id === source.hostId)?.label ?? "Device host";
  const cornerRadius = useCallback(
    (player: PreviewMiniPlayerSize) => resolveDeviceMiniPlayerCornerRadius(source.platform, player),
    [source.platform],
  );

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openDevice(threadRef, {
      hostId: source.hostId,
      deviceId: source.deviceId,
      platform: source.platform,
      name: source.name,
    });
  };

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      label="Floating device preview"
      title={device?.name ?? source.name}
      onOpenInPanel={openInPanel}
      cornerRadius={cornerRadius}
    >
      {(frame) => (
        // The stream is DOM, so it takes the band the browser's native webview would.
        <div
          className="pointer-events-auto absolute overflow-hidden"
          style={{
            ...contentBoxStyle(frame),
            borderBottomLeftRadius: "inherit",
            borderBottomRightRadius: "inherit",
            zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
          }}
        >
          <DeviceStreamView
            environmentId={threadRef.environmentId}
            platform={source.platform}
            deviceId={source.deviceId}
            hostId={source.hostId}
            deviceName={device?.name ?? source.name}
            deviceDescription={`${hostLabel} · ${device?.version ?? source.platform}`}
            visible
            onScreen={setScreen}
          />
        </div>
      )}
    </MiniPlayerShell>
  );
}

/**
 * The frame, drag/resize gestures, and hover pill shared by every floating
 * source. Native clipping and the DOM frame use the same radius so their
 * separately composited edges stay aligned.
 */
function MiniPlayerShell({
  threadRef,
  miniPlayer,
  sourceSize,
  label,
  title,
  onOpenInPanel,
  pillActions,
  recording = false,
  stripHint = false,
  cornerRadius = frameCornerRadius,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly label: string;
  /** Shown in the handle strip. */
  readonly title: string;
  readonly onOpenInPanel: () => void;
  readonly pillActions?: ReactNode;
  readonly recording?: boolean;
  /** Draw a grab line where the idle strip is (see the browser player). */
  readonly stripHint?: boolean;
  /** The clip radius for a given frame; the pill stays inside the curve. */
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const canvas = useChatCanvas();
  const gestureRef = useRef<PointerGesture | null>(null);
  const moveRef = useRef<MoveGesture | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const container = canvas?.container ?? null;
  const obstacles = NO_PREVIEW_MINI_PLAYER_OBSTACLES;
  const sourceKey = previewMiniPlayerSourceKey(miniPlayer.source);
  const frame = canvas?.previewKey === sourceKey ? canvas.layout.frame : null;
  const { width: sourceWidth, height: sourceHeight } = sourceSize;
  const reportPreview = canvas?.reportPreview;
  const clearPreview = canvas?.clearPreview;
  useLayoutEffect(() => {
    reportPreview?.({
      key: sourceKey,
      width: miniPlayer.width,
      position: miniPlayer.position,
      lastInteraction: miniPlayer.lastInteraction,
      source: { width: sourceWidth, height: sourceHeight },
      stripHeight: PREVIEW_MINI_PLAYER_STRIP_HEIGHT,
    });
  }, [
    reportPreview,
    sourceKey,
    miniPlayer.width,
    miniPlayer.position,
    miniPlayer.lastInteraction,
    sourceWidth,
    sourceHeight,
  ]);
  useLayoutEffect(() => () => clearPreview?.(sourceKey), [clearPreview, sourceKey]);

  const radius = frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  // Inside a wide curve the default inset would land on the clipped-away corner.
  const stripInset = Math.max(4, Math.round(radius * 0.55) - 4);

  // Closing hides it for this conversation; the agent's browser keeps running.
  const close = () => {
    usePreviewMiniPlayerStore.getState().dismiss(threadRef);
  };

  const commitPosition = (position: PreviewMiniPlayerPosition) => {
    usePreviewMiniPlayerStore.getState().move(threadRef, sourceKey, position);
    writeStoredMiniPlayerPosition(position);
  };

  const resetPosition = () => {
    usePreviewMiniPlayerStore.getState().resetPosition(threadRef, sourceKey);
    writeStoredMiniPlayerPosition(null);
  };

  const endMove = (commit: boolean) => {
    const move = moveRef.current;
    if (!move) return;
    moveRef.current = null;
    setDragging(false);
    if (move.frameRequest !== null) window.cancelAnimationFrame(move.frameRequest);
    const moved = move.next.x !== move.frame.x || move.next.y !== move.frame.y;
    if (commit && moved) commitPosition(move.next);
    // React applies the committed frame before the next paint, so clearing the
    // transform in the same task leaves one painted state.
    if (sectionRef.current) sectionRef.current.style.transform = "";
    if (!(commit && moved)) requestBrowserSurfaceRelayout();
  };
  useEffect(
    () => () => {
      const move = moveRef.current;
      if (move?.frameRequest != null) window.cancelAnimationFrame(move.frameRequest);
      moveRef.current = null;
    },
    [],
  );

  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !frame) return;
    moveRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      next: { x: frame.x, y: frame.y },
      frameRequest: null,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleMovePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const move = moveRef.current;
    const section = sectionRef.current;
    if (!move || move.pointerId !== event.pointerId || !container || !section) return;
    move.next = dragMiniPlayerPosition(
      move.frame,
      { x: event.clientX - move.pointerX, y: event.clientY - move.pointerY },
      container,
    );
    section.style.transform = `translate3d(${move.next.x - move.frame.x}px, ${move.next.y - move.frame.y}px, 0)`;
    // The page is a separate fixed layer, so it follows once per frame.
    move.frameRequest ??= window.requestAnimationFrame(() => {
      move.frameRequest = null;
      requestBrowserSurfaceRelayout();
    });
  };

  const handleMovePointerEnd = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    if (moveRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endMove(commit);
  };

  const handleGripKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      resetPosition();
      return;
    }
    if (!frame || !container) return;
    const next = keyboardMiniPlayerPosition(frame, event.key, event.shiftKey, container);
    if (!next) return;
    event.preventDefault();
    commitPosition(next);
  };

  const beginResize = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection,
  ) => {
    if (event.button !== 0 || !frame) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta: { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY },
      source: sourceSize,
      container,
      obstacles,
      stripHeight: PREVIEW_MINI_PLAYER_STRIP_HEIGHT,
    });
    usePreviewMiniPlayerStore
      .getState()
      .resize(threadRef, sourceKey, next.width, { x: next.x, y: next.y });
  };

  const endResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Buttons on the strip must neither start a move nor count as a reset click.
  const stopStripGesture = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => event.stopPropagation(),
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation(),
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      {frame ? (
        <section
          ref={sectionRef}
          aria-label={label}
          data-preview-mini-player={sourceKey}
          className="group/mini pointer-events-none absolute select-none"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
            borderRadius: radius,
          }}
        >
          <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
          {children(frame)}
          <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
          {/*
            The strip owns the top of the frame and the page starts below it, so
            it is never under the page: the native view's bounds exclude it. The
            whole strip drags. It fades in on hover or focus and while dragging
            (opacity only, 150ms ease-out, none under reduced motion) and stays
            shown on touch screens. A hosted webview's hover never reaches this
            document, so its idle strip shows a thin grab line instead.
          */}
          {stripHint ? (
            <div
              aria-hidden
              data-preview-mini-player-hint=""
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 z-[48] flex items-center justify-center",
                "transition-opacity duration-150 ease-out motion-reduce:transition-none",
                "group-hover/mini:opacity-0 group-focus-within/mini:opacity-0 pointer-coarse:opacity-0",
                dragging && "opacity-0",
              )}
              style={{ height: PREVIEW_MINI_PLAYER_STRIP_HEIGHT }}
            >
              <span className="h-1 w-10 rounded-full bg-foreground/25" />
              {recording ? (
                <span className="absolute left-3 size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
              ) : null}
            </div>
          ) : null}
          <div
            data-preview-mini-player-handle=""
            data-dragging={dragging ? "" : undefined}
            className={cn(
              "pointer-events-auto absolute inset-x-0 top-0 z-[49] flex touch-none cursor-grab items-center gap-0.5 border-b border-border/70 bg-popover/80 backdrop-blur-md active:cursor-grabbing",
              "transition-opacity duration-150 ease-out motion-reduce:transition-none",
              "opacity-0 group-hover/mini:opacity-100 group-focus-within/mini:opacity-100 data-[dragging]:opacity-100 pointer-coarse:opacity-100",
            )}
            style={{
              height: PREVIEW_MINI_PLAYER_STRIP_HEIGHT,
              paddingInline: stripInset,
              borderTopLeftRadius: radius,
              borderTopRightRadius: radius,
            }}
            onPointerDown={beginMove}
            onPointerMove={handleMovePointerMove}
            onPointerUp={(event) => handleMovePointerEnd(event, true)}
            onPointerCancel={(event) => handleMovePointerEnd(event, false)}
            onDoubleClick={resetPosition}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Move Preview"
                    aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight Home"
                    className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                    onKeyDown={handleGripKeyDown}
                  />
                }
              >
                <GripHorizontalIcon className="size-4" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">
                Drag to move. Arrow keys nudge, Home or double-click resets.
              </TooltipPopup>
            </Tooltip>
            {recording ? (
              <span
                role="status"
                aria-label="Recording Preview"
                className="flex size-4 shrink-0 items-center justify-center"
              >
                <span className="size-2 rounded-full bg-destructive motion-safe:animate-status-pulse" />
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
              {title}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Open In Side Panel"
                    {...stopStripGesture}
                    onClick={onOpenInPanel}
                  />
                }
              >
                <PanelRightIcon />
                Expand
              </TooltipTrigger>
              <TooltipPopup side="top">Open In Side Panel</TooltipPopup>
            </Tooltip>
            {pillActions}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Close Preview"
                    {...stopStripGesture}
                    onClick={close}
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Close Preview</TooltipPopup>
            </Tooltip>
          </div>
          {RESIZE_HANDLES.map(({ direction, className }) => (
            <div
              key={direction}
              role="presentation"
              data-preview-mini-player-resize={direction}
              className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
              onPointerDown={(event) => beginResize(event, direction)}
              onPointerMove={handleResizePointerMove}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
