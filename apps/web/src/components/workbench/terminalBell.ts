const ESC = "\x1b";
const BEL = "\x07";

/**
 * Reports whether a chunk of terminal output rings the bell. BEL also ends an
 * OSC sequence (shells set the window title that way on every prompt), so the
 * scanner remembers an OSC left open by the previous chunk.
 */
export function createBellScanner(): (data: string) => boolean {
  let inOsc = false;
  let pendingEsc = false;
  return (data) => {
    let rang = false;
    for (const char of data) {
      if (inOsc) {
        // ST (ESC \) or BEL closes the sequence.
        if (char === BEL || (pendingEsc && char === "\\")) inOsc = false;
        pendingEsc = char === ESC;
      } else if (pendingEsc) {
        pendingEsc = false;
        if (char === "]") inOsc = true;
        else if (char === BEL) rang = true;
      } else if (char === ESC) pendingEsc = true;
      else if (char === BEL) rang = true;
    }
    return rang;
  };
}
