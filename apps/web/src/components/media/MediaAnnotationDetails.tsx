import type { MediaAnnotationContextRecord } from "@t3tools/contracts";

import { formatBoxPercent, formatTimeRange } from "~/lib/mediaReview";

export interface MediaAnnotationFrame {
  readonly key: string;
  readonly url: string;
  readonly label: string;
  readonly onExpand?: (() => void) | undefined;
}

/**
 * What one media note says, for the chip popover in the composer and in a sent message. A sent
 * message also shows the frames the agent was given, with the circled region drawn on them.
 */
export function MediaAnnotationDetails(props: {
  readonly record: Pick<
    MediaAnnotationContextRecord,
    "filePath" | "mediaKind" | "timeStart" | "timeEnd" | "box" | "comment" | "framesNote"
  >;
  readonly frames?: ReadonlyArray<MediaAnnotationFrame>;
}) {
  const { record } = props;
  const fileName = record.filePath.split("/").at(-1) ?? record.filePath;
  const facts = [
    record.mediaKind === "video" ? "Video" : "Image",
    record.timeStart !== undefined ? formatTimeRange(record.timeStart, record.timeEnd) : null,
    record.box ? formatBoxPercent(record.box) : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.frames && props.frames.length > 0 ? (
        <ul
          aria-label="Frames the agent was shown"
          className="flex gap-1.5 overflow-x-auto border-border/70 border-b bg-muted/40 p-2"
        >
          {props.frames.map((frame) => (
            <li key={frame.key} className="shrink-0">
              <button
                type="button"
                aria-label={frame.label}
                disabled={frame.onExpand === undefined}
                onClick={frame.onExpand}
                className="block cursor-zoom-in overflow-hidden rounded-md border border-border/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default"
              >
                <img src={frame.url} alt={frame.label} className="h-20 w-auto object-contain" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="min-w-0 px-3 py-2.5">
        <div className="truncate text-message-foreground text-xs font-medium">{fileName}</div>
        <div className="mt-0.5 text-secondary-label text-3xs">{facts.join(" · ")}</div>
        {record.comment ? (
          <div className="mt-1.5 whitespace-pre-wrap wrap-break-word text-sm">{record.comment}</div>
        ) : null}
        {record.framesNote ? (
          <div className="mt-1.5 text-secondary-label text-3xs">
            No frames were attached: {record.framesNote}
          </div>
        ) : null}
      </div>
    </div>
  );
}
