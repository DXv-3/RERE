/**
 * Keeps everything said in one dictation, across the recognizer's restarts.
 *
 * Apple's on-device recognizer reports "the whole transcript so far", but after a pause it starts
 * a new utterance and its transcript begins again from nothing. Taken at face value that erases
 * what was said before the pause. A report that is suddenly far shorter than the last one is a
 * new utterance, so the earlier one is kept and the new one is added after it.
 */
export interface TranscriptAccumulator {
  /** Takes the recognizer's latest report and returns everything said so far. */
  readonly update: (reported: string) => string;
  readonly text: () => string;
  readonly reset: () => void;
}

const words = (text: string) => text.split(/\s+/).filter((word) => word.length > 0);

/**
 * A revision rewrites a few words and stays about as long. A restart drops to the first word or
 * two of a new sentence. Short utterances are left alone: one that shrinks is as likely a
 * correction ("I scream" to "Ice cream") as a restart.
 */
export function isUtteranceRestart(previous: string, next: string): boolean {
  const before = words(previous);
  const after = words(next);
  if (before.length < 3) return false;
  if (after.length === 0) return false;
  if (after.length * 2 > before.length) return false;
  // The same opening words, only fewer of them, is the recognizer backing up, not starting over.
  const sameOpening = after.every(
    (word, index) => word.toLowerCase() === before[index]?.toLowerCase(),
  );
  return !sameOpening;
}

export function createTranscriptAccumulator(): TranscriptAccumulator {
  let kept = "";
  let current = "";
  const text = () => [kept, current].filter((part) => part.length > 0).join(" ");
  return {
    update: (reported) => {
      const next = reported.trim();
      // An empty report after speech is the recognizer clearing itself, never the user unsaying it.
      if (next.length === 0) return text();
      if (isUtteranceRestart(current, next)) {
        kept = text();
      }
      current = next;
      return text();
    },
    text,
    reset: () => {
      kept = "";
      current = "";
    },
  };
}
