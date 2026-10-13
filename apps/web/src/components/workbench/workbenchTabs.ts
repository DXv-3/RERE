import { Bot, Code2, MessageSquare } from "lucide-react";
import type { KeybindingCommand } from "@t3tools/contracts";

import type { WorkbenchMode } from "./workbenchStore";

export const WORKBENCH_TAB_COMMANDS = {
  agent: "workbench.showAgents",
  code: "workbench.showCode",
  thread: "workbench.showThreads",
} as const satisfies Record<WorkbenchMode, KeybindingCommand>;

export const WORKBENCH_TAB_ITEMS = [
  { mode: "agent", label: "Agents", Icon: Bot },
  { mode: "code", label: "Code", Icon: Code2 },
  { mode: "thread", label: "Threads", Icon: MessageSquare },
] as const;

export function workbenchTabForCommand(command: string | null): WorkbenchMode | null {
  for (const [mode, tabCommand] of Object.entries(WORKBENCH_TAB_COMMANDS)) {
    if (tabCommand === command) return mode as WorkbenchMode;
  }
  return null;
}

let openTab: ((mode: WorkbenchMode) => void) | null = null;

/** The shell registers the function its tab buttons call, so shortcuts and the palette share it. */
export function registerWorkbenchTabOpener(opener: ((mode: WorkbenchMode) => void) | null) {
  openTab = opener;
}

export function openWorkbenchTab(mode: WorkbenchMode) {
  openTab?.(mode);
}
