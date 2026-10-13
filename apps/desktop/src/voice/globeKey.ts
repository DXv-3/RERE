// @effect-diagnostics nodeBuiltinImport:off -- Reads a macOS preference with the defaults tool.

import * as NodeChildProcess from "node:child_process";

import type { DesktopGlobeKeyAction } from "@t3tools/contracts";

// AppleFnUsageType, as System Settings writes it for "Press Globe key to".
const ACTIONS: Readonly<Record<string, DesktopGlobeKeyAction>> = {
  "0": "nothing",
  "1": "input-source",
  "2": "emoji",
  "3": "dictation",
};

export function parseGlobeKeyAction(output: string): DesktopGlobeKeyAction {
  return ACTIONS[output.trim()] ?? "unknown";
}

/** What macOS itself does when Fn (Globe) is pressed alone. Unknown when it was never set. */
export function readGlobeKeyAction(): Promise<DesktopGlobeKeyAction> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/defaults",
      ["read", "com.apple.HIToolbox", "AppleFnUsageType"],
      { timeout: 3000 },
      (error, stdout) => resolve(error ? "unknown" : parseGlobeKeyAction(stdout)),
    );
  });
}
