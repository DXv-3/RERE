/** One recording's footprint in a draft: what was there before, and what dictation last wrote. */
export interface DictationSession {
  /** The draft before any dictated words were added. */
  readonly base: string;
  /** The dictated piece last appended, including its separator. */
  readonly piece: string;
  /** The whole draft as dictation last wrote it. */
  readonly written: string;
  /** The draft was sent or emptied mid-recording; later words are dropped. */
  readonly detached: boolean;
}

const join = (base: string, text: string) => {
  const piece = base.trim() ? `\n${text}` : text;
  return { piece, prompt: base.trim() ? `${base}${piece}` : piece };
};

/**
 * Puts the words heard so far (or the final transcript) into the draft,
 * replacing what the same recording wrote before. `pendingFrom` is where the
 * dictated words start, for tinting them while they are provisional.
 *
 * A draft the user edited mid-recording keeps the edit and dictation continues
 * after it. A draft that was emptied was sent, so the recording detaches rather
 * than repeat those words in the next message.
 */
export function applyDictatedText(
  session: DictationSession | null,
  current: string,
  text: string,
): { session: DictationSession; prompt: string | null; pendingFrom: number | null } {
  if (session?.detached) return { session, prompt: null, pendingFrom: null };
  let base = session?.base ?? current;
  if (session && current !== session.written) {
    if (current.trim() === "" && session.written.trim() !== "") {
      return { session: { ...session, detached: true }, prompt: null, pendingFrom: null };
    }
    base = current.endsWith(session.piece)
      ? current.slice(0, current.length - session.piece.length)
      : current;
  }
  const { piece, prompt } = join(base, text);
  return {
    session: { base, piece, written: prompt, detached: false },
    prompt,
    pendingFrom: prompt.length - text.length,
  };
}

/** The draft with this recording's words removed, or null when the user has edited since. */
export function withoutDictatedText(session: DictationSession, current: string): string | null {
  if (session.detached || current !== session.written) return null;
  return session.base;
}
