/** Conservative guard for a model stuck repeating prose within one text block.
 * Tool payloads and fenced code are never fed into the repetition window.
 */
export class RepeatedProseGuard {
  private pending = "";
  private paragraph = "";
  private fence: string | null = null;
  private prose = "";
  private readonly paragraphs: string[] = [];

  append(delta: string): boolean {
    this.pending += delta;
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, newline).trim();
      this.pending = this.pending.slice(newline + 1);
      const fence = /^(```|~~~)/.exec(line)?.[1];
      if (fence) {
        this.paragraph = "";
        this.paragraphs.length = 0;
        this.prose = "";
        if (this.fence === null) this.fence = fence;
        else if (this.fence === fence) this.fence = null;
        continue;
      }
      if (this.fence !== null) continue;
      if (line) {
        this.prose = `${this.prose} ${line}`.slice(-8192);
        if (hasRepeatedSuffix(this.prose)) return true;
        this.paragraph = `${this.paragraph} ${line}`.slice(-4096);
        continue;
      }
      const paragraph = this.paragraph.trim();
      this.paragraph = "";
      if (!paragraph) continue;
      this.paragraphs.push(paragraph);
      if (this.paragraphs.length > 32) this.paragraphs.shift();
      if (paragraph.length < 120) continue;
      const copies = this.paragraphs.filter((entry) => entry === paragraph).length;
      const total = this.paragraphs.reduce((sum, entry) => sum + entry.length, 0);
      if (copies >= 6 && total >= 2000 && copies * paragraph.length >= total / 2) {
        return true;
      }
    }
    // A model may output an unbroken line indefinitely. Bound retained memory.
    this.pending = this.pending.slice(-4096);
    return (
      this.fence === null &&
      !/^\s*(```|~~~)/.test(this.pending) &&
      hasRepeatedSuffix(`${this.prose} ${this.pending}`)
    );
  }
}

/** Match complete consecutive copies regardless of line or chunk boundaries. */
function hasRepeatedSuffix(text: string): boolean {
  const prose = text.replace(/\s+/g, " ").trim().slice(-8192);
  if (prose.length < 2000) return false;
  for (let size = 1; size <= Math.floor(prose.length / 6); size++) {
    const copies = Math.max(6, Math.ceil(2000 / size));
    const length = copies * size;
    if (length > prose.length) continue;
    const end = prose.length;
    if (prose.slice(end - length, end - size) === prose.slice(end - length + size)) {
      // Reject short repeating labels, even when a multiple also forms a long period.
      return size >= 120;
    }
  }
  return false;
}
