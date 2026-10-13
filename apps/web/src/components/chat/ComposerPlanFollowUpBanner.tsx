import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { requestPlanJump } from "../../planJumpBus";
import { stripDisplayedPlanMarkdown } from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

/**
 * "Plan ready" row above the composer. It is a disclosure button: opening it shows the plan in
 * place, so it can be read without leaving the composer, and "Jump To Plan In Thread" scrolls the
 * timeline to the full card.
 */
export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planId,
  planMarkdown,
  planTitle,
  environmentId,
  threadRef,
  cwd,
}: {
  planId: string;
  planMarkdown: string;
  planTitle: string | null;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | undefined;
  cwd: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Focus moves into the plan when it opens, so the keyboard can scroll it.
  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    },
    [open],
  );
  return (
    <div className="min-w-0" onKeyDown={handleKeyDown}>
      <ComposerBanner.Row
        render={
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={() => setOpen((value) => !value)}
          />
        }
      >
        <ComposerBanner.Icon />
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium text-muted-foreground">Plan ready</span>
          {planTitle ? (
            <span className="min-w-0 flex-1 truncate text-foreground/85">{planTitle}</span>
          ) : null}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.ToggleIcon expanded={open} />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          aria-label={planTitle ?? "Plan"}
          tabIndex={-1}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ComposerBanner.Scroll className="max-h-[60dvh]">
            <div className="min-w-0 px-2 pb-1 text-sm">
              <ChatMarkdown
                text={stripDisplayedPlanMarkdown(planMarkdown)}
                cwd={cwd}
                environmentId={environmentId}
                threadRef={threadRef}
                isStreaming={false}
                headingLevelOffset={3}
              />
            </div>
          </ComposerBanner.Scroll>
          <div className="flex justify-end px-1 pt-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                requestPlanJump(planId);
              }}
            >
              <ArrowUpIcon aria-hidden />
              Jump To Plan In Thread
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
});
