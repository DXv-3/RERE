import type { TerminalAgentState } from "@t3tools/contracts";

/**
 * How a coding CLI reports its state through its own terminal output:
 *
 * - `hook`: the CLI's hooks print `OSC 9001 ; <state> BEL`. Exact, covers every
 *   transition.
 * - `notification`: the CLI's desktop notification (`OSC 9 ; <message> BEL`).
 *   Only says a turn ended or an approval is pending, never that work began.
 */
export interface AgentStatus {
  readonly state: TerminalAgentState | null;
  readonly source: "hook" | "notification" | null;
}

export const NO_AGENT_STATUS: AgentStatus = { state: null, source: null };

const ESC = "\x1b";
const MAX_PENDING_LENGTH = 1024;
// oxlint-disable-next-line no-control-regex
const SIGNAL = /\x1b\](9001|9);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
// oxlint-disable-next-line no-control-regex
const TERMINATOR = /\x07|\x1b\\/;
const HOOK_STATES: ReadonlySet<string> = new Set(["working", "needs-you", "idle"]);
const NEEDS_YOU_NOTIFICATION = /^(Approval requested|Plan mode prompt|Question requested)/;

function toStatus(code: string, payload: string): AgentStatus | null {
  if (code === "9001") {
    return HOOK_STATES.has(payload)
      ? { state: payload as TerminalAgentState, source: "hook" }
      : null;
  }
  // `OSC 9 ; <digits> ; ...` is a terminal command (progress bar and the like), not a message.
  if (payload === "" || /^\d+;/.test(payload)) return null;
  return {
    state: NEEDS_YOU_NOTIFICATION.test(payload) ? "needs-you" : "idle",
    source: "notification",
  };
}

/**
 * Returns the last status reported in a chunk of terminal output, or null. Keeps
 * a sequence left open at the end of one chunk so it completes with the next.
 */
export function createAgentStatusScanner(): (data: string) => AgentStatus | null {
  let pending = "";
  return (data) => {
    if (pending === "" && !data.includes(ESC)) return null;
    const text = pending + data;
    let last: AgentStatus | null = null;
    for (const match of text.matchAll(SIGNAL)) {
      last = toStatus(match[1]!, match[2]!) ?? last;
    }
    const open = text.lastIndexOf(`${ESC}]`);
    const tail = open >= 0 && !TERMINATOR.test(text.slice(open + 2)) ? text.slice(open) : "";
    pending = tail.length > MAX_PENDING_LENGTH ? "" : tail || (text.endsWith(ESC) ? ESC : "");
    return last;
  };
}

/** A CLI with hooks is the authority on itself; its notifications add nothing. */
export function applyAgentReport(current: AgentStatus, report: AgentStatus): AgentStatus {
  return current.source === "hook" && report.source === "notification" ? current : report;
}

/**
 * Notifications never say a turn began, so the user's reply is what ends "idle"
 * and "needs you": any key answers an approval, Enter sends a prompt.
 */
export function applyAgentInput(current: AgentStatus, data: string): AgentStatus {
  if (current.source !== "notification" || current.state === null) return current;
  if (current.state === "idle" && !data.includes("\r")) return current;
  return { state: null, source: "notification" };
}
