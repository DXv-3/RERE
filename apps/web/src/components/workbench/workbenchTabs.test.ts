import { describe, expect, it } from "vite-plus/test";

import { WORKBENCH_TAB_COMMANDS, workbenchTabForCommand } from "./workbenchTabs";

describe("workbench tab commands", () => {
  it("maps every tab command back to its tab", () => {
    for (const [mode, command] of Object.entries(WORKBENCH_TAB_COMMANDS)) {
      expect(workbenchTabForCommand(command)).toBe(mode);
    }
  });

  it("ignores other commands", () => {
    expect(workbenchTabForCommand("sidebar.toggle")).toBeNull();
    expect(workbenchTabForCommand(null)).toBeNull();
  });
});
