import * as Schema from "effect/Schema";

import { parseStoredMiniPlayerPosition } from "./components/preview/previewMiniPlayerPlacement";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";
import type { PreviewMiniPlayerPosition } from "./previewMiniPlayerStore";

const POSITION_STORAGE_KEY = "t3code:preview-mini-player-position:v1";

const StoredPosition = Schema.Struct({ x: Schema.Number, y: Schema.Number });

/**
 * Where this client last left the floating preview. Storage can be missing,
 * blocked, or hold something that is not a position; every one of those reads
 * as "no preference" so the preview opens in its default corner.
 */
export function readStoredMiniPlayerPosition(): PreviewMiniPlayerPosition | null {
  try {
    return parseStoredMiniPlayerPosition(getLocalStorageItem(POSITION_STORAGE_KEY, StoredPosition));
  } catch {
    return null;
  }
}

/** `null` forgets the preference, so the next preview opens in its default corner. */
export function writeStoredMiniPlayerPosition(position: PreviewMiniPlayerPosition | null): void {
  try {
    if (position === null) {
      removeLocalStorageItem(POSITION_STORAGE_KEY);
      return;
    }
    setLocalStorageItem(POSITION_STORAGE_KEY, position, StoredPosition);
  } catch {
    // A full or blocked store only costs the remembered position.
  }
}
