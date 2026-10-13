import type { MediaAnnotationContextRecord } from "@t3tools/contracts";
import {
  allocateAnnotationFrames,
  MEDIA_ANNOTATION_MESSAGE_MAX_FRAMES,
  planAnnotationFrameTimes,
} from "@t3tools/shared/mediaAnnotations";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { toKindScopedComposerContextId } from "./composerContextReferences";
import { dataUrlToFile } from "./imageCompression";
import { MEDIA_FRAME_NAME_PREFIX } from "./mediaReview";

/**
 * Turns the media notes in a draft into what a message carries: each note gains the ids of its
 * frame attachments, and the frames themselves come back as bytes for the caller to attach. The
 * server cuts the frames (so remote environments and codecs the browser cannot draw work), and
 * every limit is enforced here so one long review cannot flood a message.
 */

export interface FetchedFrame {
  readonly at: number;
  readonly base64: string;
  readonly mimeType: "image/jpeg";
}

export interface PreparedMediaFrame extends FetchedFrame {
  /** Local attachment id; the record's `frameContextIds` point at its image context. */
  readonly attachmentId: string;
  readonly name: string;
  readonly annotationId: string;
}

export interface PreparedMediaAnnotations {
  readonly records: MediaAnnotationContextRecord[];
  readonly frames: PreparedMediaFrame[];
  /** One line for the person when frames were trimmed or could not be made; null when all went well. */
  readonly notice: string | null;
}

/** Why frames are missing, in words an agent can pass on. Never the server's raw output. */
function describeFrameFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.trim().slice(0, 200) || "the server could not produce frames";
}

export async function prepareMediaAnnotationFrames(input: {
  readonly records: ReadonlyArray<MediaAnnotationContextRecord>;
  readonly fetchFrames: (
    record: MediaAnnotationContextRecord,
    times: ReadonlyArray<number>,
  ) => Promise<ReadonlyArray<FetchedFrame>>;
  readonly maxFrames?: number;
}): Promise<PreparedMediaAnnotations> {
  const plans = input.records.map((record) => planAnnotationFrameTimes(record));
  const allocation = allocateAnnotationFrames(
    plans.map((plan) => plan.length),
    input.maxFrames ?? MEDIA_ANNOTATION_MESSAGE_MAX_FRAMES,
  );
  const frames: PreparedMediaFrame[] = [];
  const failures: string[] = [];

  const records = await Promise.all(
    input.records.map(async (record, index): Promise<MediaAnnotationContextRecord> => {
      // Frames from an earlier attempt never carry over; they are made fresh each send.
      const { frameContextIds: _ids, frameTimes: _times, framesNote: _note, ...bare } = record;
      const kept = allocation.keep[index] ?? [];
      if (kept.length === 0) {
        return {
          ...bare,
          framesNote: "this message already carries the most frames it can",
        };
      }
      const times = kept.map((frameIndex) => plans[index]![frameIndex]!);
      try {
        const fetched = await input.fetchFrames(record, times);
        if (fetched.length === 0) throw new Error("the server returned no frames");
        const made = fetched.map((frame, position): PreparedMediaFrame => {
          const attachmentId = `${MEDIA_FRAME_NAME_PREFIX}${record.annotationId}-${position + 1}`;
          return {
            ...frame,
            attachmentId,
            name: `${attachmentId}.jpg`,
            annotationId: record.annotationId,
          };
        });
        frames.push(...made);
        return {
          ...bare,
          frameContextIds: made.map((frame) =>
            toKindScopedComposerContextId("image", frame.attachmentId),
          ),
          frameTimes: made.map((frame) => frame.at),
        };
      } catch (error) {
        const reason = describeFrameFailure(error);
        failures.push(reason);
        return { ...bare, framesNote: reason };
      }
    }),
  );

  const notes: string[] = [];
  if (failures.length > 0) {
    notes.push(
      `Frames could not be attached to ${failures.length === 1 ? "a note" : `${failures.length} notes`}: ${failures[0]}.`,
    );
  }
  if (allocation.trimmed) {
    notes.push(
      `Sent ${frames.length} frames; the limit is ${input.maxFrames ?? MEDIA_ANNOTATION_MESSAGE_MAX_FRAMES} per message, so some were left out. The notes still went with their comments.`,
    );
  }
  return { records, frames, notice: notes.length > 0 ? notes.join(" ") : null };
}

/** A prepared frame as the composer's own image attachment, so it uploads like any other image. */
export function frameToComposerImage(frame: PreparedMediaFrame): ComposerImageAttachment {
  const dataUrl = `data:${frame.mimeType};base64,${frame.base64}`;
  const file = dataUrlToFile(dataUrl, frame.name, frame.mimeType);
  return {
    type: "image",
    id: frame.attachmentId,
    name: frame.name,
    mimeType: frame.mimeType,
    sizeBytes: file.size,
    previewUrl: dataUrl,
    file,
  };
}

/** Frames are made fresh for each send, so a failed send must not leave them in the draft. */
export const isNotMediaFrameImage = (image: { readonly id: string }): boolean =>
  !image.id.startsWith(MEDIA_FRAME_NAME_PREFIX);
