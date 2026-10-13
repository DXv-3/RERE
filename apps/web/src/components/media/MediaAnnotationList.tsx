import type { MediaAnnotation } from "@t3tools/contracts";
import { CheckIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

import { formatBoxPercent, formatTimeRange } from "~/lib/mediaReview";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/** Where a note points, in one short phrase. */
function describeAnnotationTarget(annotation: MediaAnnotation): string {
  const parts = [
    annotation.timeStart !== undefined
      ? formatTimeRange(annotation.timeStart, annotation.timeEnd)
      : null,
    annotation.box ? formatBoxPercent(annotation.box) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Whole file";
}

/**
 * The notes on this file, in time order. Jump moves the playhead (and shows the note's region),
 * Resolve keeps the note in the file's history, Remove deletes it.
 */
export function MediaAnnotationList(props: {
  readonly annotations: ReadonlyArray<MediaAnnotation>;
  readonly onJump: (annotation: MediaAnnotation) => void;
  readonly onSetStatus: (id: string, status: "open" | "resolved") => void;
  readonly onRemove: (id: string) => void;
}) {
  if (props.annotations.length === 0) {
    return (
      <p className="px-1 text-muted-foreground text-xs">
        No notes yet. Circle part of the picture or drag on the timeline, say what should change,
        and add it to your message.
      </p>
    );
  }
  return (
    <ul aria-label="Notes on this file" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
      {props.annotations.map((annotation) => {
        const resolved = annotation.status === "resolved";
        const target = describeAnnotationTarget(annotation);
        return (
          <li
            key={annotation.id}
            className="flex min-w-0 flex-col gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1.5"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <button
                type="button"
                aria-label={`Jump to note: ${target}`}
                onClick={() => props.onJump(annotation)}
                className="min-w-0 cursor-pointer truncate rounded-sm text-left font-medium text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {target}
              </button>
              <span className="flex shrink-0 items-center gap-0.5">
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={resolved ? "Reopen note" : "Resolve note"}
                  onClick={() => props.onSetStatus(annotation.id, resolved ? "open" : "resolved")}
                >
                  {resolved ? <RotateCcwIcon /> : <CheckIcon />}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label="Remove note"
                  onClick={() => props.onRemove(annotation.id)}
                >
                  <Trash2Icon />
                </Button>
              </span>
            </div>
            <p
              className={cn(
                "line-clamp-3 whitespace-pre-wrap wrap-break-word text-xs",
                resolved && "text-muted-foreground line-through",
              )}
            >
              {annotation.comment || "No comment"}
            </p>
            {resolved ? <span className="text-3xs text-muted-foreground">Resolved</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
