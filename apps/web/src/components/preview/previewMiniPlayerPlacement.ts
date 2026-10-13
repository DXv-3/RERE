import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";

import {
  clampPreviewMiniPlayerPosition,
  type PreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

/** Arrow keys on the focused handle move the floating preview this far. */
export const PREVIEW_MINI_PLAYER_KEY_STEP = 16;
/** Shift plus an arrow key. */
export const PREVIEW_MINI_PLAYER_KEY_STEP_LARGE = 64;

// Far beyond any real screen; a stored value past this is garbage, not a position.
const MAX_STORED_COORDINATE = 100_000;

/**
 * A position read back from client storage. Anything that is not a pair of
 * finite, sane numbers is dropped so a garbled value falls back to the default
 * corner instead of placing the preview somewhere unreachable.
 */
export function parseStoredMiniPlayerPosition(value: unknown): PreviewMiniPlayerPosition | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_STORED_COORDINATE || Math.abs(y) > MAX_STORED_COORDINATE) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Where a drag that started on `start` lands: the frame moved by `delta`, kept
 * fully inside the container so the handle is always within reach.
 */
export function dragMiniPlayerPosition(
  start: PreviewMiniPlayerFrame,
  delta: PreviewMiniPlayerPosition,
  container: PreviewMiniPlayerSize,
): PreviewMiniPlayerPosition {
  return clampPreviewMiniPlayerPosition(
    { x: start.x + delta.x, y: start.y + delta.y },
    container,
    start,
  );
}

const ARROW_DIRECTIONS: Readonly<Record<string, PreviewMiniPlayerPosition>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** The position an arrow key moves the frame to, or null for any other key. */
export function keyboardMiniPlayerPosition(
  frame: PreviewMiniPlayerFrame,
  key: string,
  shiftKey: boolean,
  container: PreviewMiniPlayerSize,
): PreviewMiniPlayerPosition | null {
  const direction = ARROW_DIRECTIONS[key];
  if (!direction) return null;
  const step = shiftKey ? PREVIEW_MINI_PLAYER_KEY_STEP_LARGE : PREVIEW_MINI_PLAYER_KEY_STEP;
  return dragMiniPlayerPosition(frame, { x: direction.x * step, y: direction.y * step }, container);
}
