/**
 * The newline-delimited JSON the macOS speech helper (native/mac-speech) prints on stdout.
 * `text` is always the whole transcript so far, never a delta.
 */
export type NativeSpeechEvent =
  | { readonly type: "ready" }
  | { readonly type: "partial"; readonly text: string }
  | { readonly type: "final"; readonly text: string }
  /** About two seconds without speech after some speech. */
  | { readonly type: "silence" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/** One line of helper output, or null when it is blank, not JSON, or a type this app does not know. */
export function parseNativeSpeechLine(line: string): NativeSpeechEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "ready":
    case "silence":
      return { type: record.type };
    case "partial":
    case "final":
      return typeof record.text === "string" ? { type: record.type, text: record.text } : null;
    case "error":
      return {
        type: "error",
        code: typeof record.code === "string" ? record.code : "unknown",
        message: typeof record.message === "string" ? record.message : "Speech recognition failed.",
      };
    default:
      return null;
  }
}

/** Joins stdout chunks into lines: a line split across chunks is held until it is complete. */
export function createNativeSpeechLineParser() {
  let pending = "";
  const drain = (lines: readonly string[]) =>
    lines.flatMap((line) => {
      const event = parseNativeSpeechLine(line);
      return event ? [event] : [];
    });
  return {
    push(chunk: string): NativeSpeechEvent[] {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      return drain(lines);
    },
    /** The helper ended: a last line with no trailing newline still counts. */
    flush(): NativeSpeechEvent[] {
      const rest = pending;
      pending = "";
      return drain([rest]);
    },
  };
}

export interface NativeSpeechProbe {
  readonly supported: boolean;
  readonly onDevice: boolean;
  readonly locale: string;
  readonly engine: string;
}

/** What `--probe` printed. Anything unreadable counts as unsupported. */
export function parseNativeSpeechProbe(output: string): NativeSpeechProbe | null {
  for (const line of output.split("\n").toReversed()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof value.supported !== "boolean" || typeof value.onDevice !== "boolean") return null;
      return {
        supported: value.supported,
        onDevice: value.onDevice,
        locale: typeof value.locale === "string" ? value.locale : "",
        engine: typeof value.engine === "string" ? value.engine : "",
      };
    } catch {
      return null;
    }
  }
  return null;
}

export const probeAllowsApple = (probe: NativeSpeechProbe | null): boolean =>
  probe !== null && probe.supported && probe.onDevice;
