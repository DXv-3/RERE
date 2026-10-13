import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Plain text with its line breaks kept, cut to `lines` lines. "Show More" appears only when the
 * text really overflows at the current width, so short text never gets a pointless toggle.
 */
export function ClampedText({ text, lines = 6 }: { text: string; lines?: number }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded || text === "") return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <>
      <p
        ref={ref}
        id={id}
        data-wb-clamped=""
        data-wb-clamped-open={expanded ? "true" : undefined}
        style={{ "--wb-clamp-lines": lines } as CSSProperties}
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          data-wb-link=""
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show Less" : "Show More"}
        </button>
      )}
    </>
  );
}
