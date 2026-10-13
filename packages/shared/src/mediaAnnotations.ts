import {
  MEDIA_ANNOTATIONS_MAX_PER_FILE,
  MEDIA_ANNOTATIONS_VERSION,
  MediaAnnotation,
  type MediaAnnotationsFile,
  type MediaKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Review notes on a media file, kept in `<file>.annotations.json` beside it, and the rules for
 * turning one note into the frames an agent is shown. Shared so the viewer, the server's
 * `media_inspect` tool and the send path agree on the same file and the same frame choices.
 */

/** At most this many frames travel with one annotation. */
const MEDIA_ANNOTATION_MAX_FRAMES = 3;
/** At most this many annotation frames travel with one message. */
export const MEDIA_ANNOTATION_MESSAGE_MAX_FRAMES = 12;
/** Ranges shorter than this are treated as one moment. */
const SINGLE_MOMENT_SECONDS = 0.2;

export function mediaAnnotationsSidecarPath(mediaPath: string): string {
  return `${mediaPath}.annotations.json`;
}

const decodeAnnotation = Schema.decodeUnknownOption(MediaAnnotation);

export type ParsedSidecar =
  | {
      readonly status: "ok";
      readonly annotations: ReadonlyArray<MediaAnnotation>;
      readonly dropped: number;
    }
  /** Written by a newer build. Leave the file alone rather than overwrite what we cannot read. */
  | { readonly status: "newer-version" }
  | { readonly status: "invalid" };

/**
 * Reads a sidecar leniently: entries that do not decode are dropped and counted, so one bad
 * hand edit does not hide the rest of the review.
 */
export function parseMediaAnnotationsSidecar(text: string): ParsedSidecar {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "invalid" };
  }
  if (typeof json !== "object" || json === null) return { status: "invalid" };
  const { version, annotations } = json as { version?: unknown; annotations?: unknown };
  if (typeof version === "number" && version > MEDIA_ANNOTATIONS_VERSION) {
    return { status: "newer-version" };
  }
  if (version !== MEDIA_ANNOTATIONS_VERSION || !Array.isArray(annotations)) {
    return { status: "invalid" };
  }
  const seen = new Set<string>();
  const kept: MediaAnnotation[] = [];
  let dropped = 0;
  for (const entry of annotations) {
    const decoded = decodeAnnotation(entry);
    if (decoded._tag === "None" || seen.has(decoded.value.id)) {
      dropped += 1;
      continue;
    }
    seen.add(decoded.value.id);
    kept.push(decoded.value);
  }
  return { status: "ok", annotations: kept.slice(0, MEDIA_ANNOTATIONS_MAX_PER_FILE), dropped };
}

/** Oldest first, one annotation per line of JSON so reviews diff well in git. */
export function serializeMediaAnnotationsSidecar(
  annotations: ReadonlyArray<MediaAnnotation>,
): string {
  const file: MediaAnnotationsFile = {
    version: MEDIA_ANNOTATIONS_VERSION,
    annotations: annotations.slice(0, MEDIA_ANNOTATIONS_MAX_PER_FILE),
  };
  const lines = file.annotations.map((annotation) => `    ${JSON.stringify(annotation)}`);
  return `{\n  "version": ${file.version},\n  "annotations": [${
    lines.length > 0 ? `\n${lines.join(",\n")}\n  ` : ""
  }]\n}\n`;
}

/**
 * Combines what is on disk with what this session holds. Entries are matched by id; the later
 * copy wins, except that a resolved note stays resolved when the other copy is still open,
 * because resolving is the deliberate act.
 */
export function mergeMediaAnnotations(
  onDisk: ReadonlyArray<MediaAnnotation>,
  local: ReadonlyArray<MediaAnnotation>,
): MediaAnnotation[] {
  const byId = new Map<string, MediaAnnotation>();
  for (const annotation of onDisk) byId.set(annotation.id, annotation);
  for (const annotation of local) {
    const existing = byId.get(annotation.id);
    byId.set(
      annotation.id,
      existing?.status === "resolved" && annotation.status === "open" ? existing : annotation,
    );
  }
  return [...byId.values()].slice(0, MEDIA_ANNOTATIONS_MAX_PER_FILE);
}

export function setMediaAnnotationStatus(
  annotations: ReadonlyArray<MediaAnnotation>,
  id: string,
  status: "open" | "resolved",
  now: string,
): MediaAnnotation[] {
  return annotations.map((annotation) => {
    if (annotation.id !== id || annotation.status === status) return annotation;
    const { resolvedAt: _previous, ...rest } = annotation;
    return status === "resolved" ? { ...rest, status, resolvedAt: now } : { ...rest, status };
  });
}

/** Where a note points, in order: by start time, then notes with no time last. */
export function sortMediaAnnotations(
  annotations: ReadonlyArray<MediaAnnotation>,
): MediaAnnotation[] {
  return [...annotations].sort(
    (left, right) =>
      (left.timeStart ?? Number.POSITIVE_INFINITY) -
        (right.timeStart ?? Number.POSITIVE_INFINITY) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

/**
 * Which moments to show an agent for one annotation: one for an image or a single moment, and
 * start, middle and end for a range. Order matches `frameKeepOrder`.
 */
export function planAnnotationFrameTimes(input: {
  readonly mediaKind: MediaKind;
  readonly timeStart?: number | undefined;
  readonly timeEnd?: number | undefined;
}): number[] {
  if (input.mediaKind === "image" || input.timeStart === undefined) return [0];
  const start = Math.max(0, input.timeStart);
  const end = Math.max(start, input.timeEnd ?? start);
  if (end - start < SINGLE_MOMENT_SECONDS) return [roundSeconds(start)];
  return [roundSeconds(start), roundSeconds((start + end) / 2), roundSeconds(end)];
}

const roundSeconds = (value: number) => Math.round(value * 100) / 100;

export interface FrameAllocation {
  /** Per annotation, the indices into its planned times that will be sent, ascending. */
  readonly keep: ReadonlyArray<ReadonlyArray<number>>;
  readonly total: number;
  /** True when frames the plan wanted were dropped to stay under the cap. */
  readonly trimmed: boolean;
}

/**
 * Shares a message's frame budget between annotations. Everyone gets the start of their range
 * first, then ends, then middles, so a long review degrades evenly instead of starving the last
 * notes. With more annotations than budget, the later ones get no frames (their text still goes).
 */
export function allocateAnnotationFrames(
  planned: ReadonlyArray<number>,
  maxTotal: number = MEDIA_ANNOTATION_MESSAGE_MAX_FRAMES,
): FrameAllocation {
  const keep: number[][] = planned.map(() => []);
  const wanted = planned.reduce(
    (sum, count) => sum + Math.min(count, MEDIA_ANNOTATION_MAX_FRAMES),
    0,
  );
  let remaining = Math.max(0, maxTotal);
  for (let rank = 0; rank < MEDIA_ANNOTATION_MAX_FRAMES && remaining > 0; rank += 1) {
    for (let index = 0; index < planned.length && remaining > 0; index += 1) {
      const count = Math.min(planned[index] ?? 0, MEDIA_ANNOTATION_MAX_FRAMES);
      const frame = frameIndexAtRank(count, rank);
      if (frame === null) continue;
      keep[index]!.push(frame);
      remaining -= 1;
    }
  }
  const sorted = keep.map((frames) => frames.sort((a, b) => a - b));
  const total = sorted.reduce((sum, frames) => sum + frames.length, 0);
  return { keep: sorted, total, trimmed: total < wanted };
}

/** Start, then end, then middle of `count` planned frames. */
function frameIndexAtRank(count: number, rank: number): number | null {
  if (count <= 0) return null;
  const order = count === 1 ? [0] : count === 2 ? [0, 1] : [0, count - 1, 1];
  return order[rank] ?? null;
}

/**
 * The notes to write when this session saves. The file may have changed since it was read (an
 * agent resolved a note, a teammate added one), so unknown entries on disk are kept, a note
 * resolved on disk stays resolved unless this session reopened it, and only notes this session
 * removed are dropped.
 */
export function reconcileMediaAnnotationsForWrite(input: {
  readonly onDisk: ReadonlyArray<MediaAnnotation>;
  readonly local: ReadonlyArray<MediaAnnotation>;
  readonly removedIds: ReadonlySet<string>;
  /** Notes whose status this session changed on purpose, so the local status wins. */
  readonly statusChangedIds?: ReadonlySet<string>;
}): MediaAnnotation[] {
  const disk = new Map(input.onDisk.map((annotation) => [annotation.id, annotation]));
  const merged = new Map<string, MediaAnnotation>();
  for (const annotation of input.onDisk) merged.set(annotation.id, annotation);
  for (const annotation of input.local) {
    const onDisk = disk.get(annotation.id);
    const keepDiskResolution =
      onDisk?.status === "resolved" &&
      annotation.status === "open" &&
      input.statusChangedIds?.has(annotation.id) !== true;
    merged.set(annotation.id, keepDiskResolution ? onDisk : annotation);
  }
  return [...merged.values()]
    .filter((annotation) => !input.removedIds.has(annotation.id))
    .slice(0, MEDIA_ANNOTATIONS_MAX_PER_FILE);
}
