import { AGENT_TOOL_GROUPS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { TOOL_ACCESS_OPTIONS, withToolGroup } from "./agentToolAccess";

describe("withToolGroup", () => {
  it("switches a group off and back on, keeping the contract's order", () => {
    const off = withToolGroup(undefined, "worktree", false);
    expect(off).toEqual(["worktree"]);
    expect(withToolGroup(off, "preview", false)).toEqual(["preview", "worktree"]);
    expect(withToolGroup(["preview", "worktree"], "preview", true)).toEqual(["worktree"]);
  });

  it("answers an explicit empty list when everything is back on", () => {
    expect(withToolGroup(["device"], "device", true)).toEqual([]);
    // Switching on something that was never off still saves a list, not a missing field.
    expect(withToolGroup(undefined, "device", true)).toEqual([]);
  });

  it("does not repeat a group that is switched off twice", () => {
    expect(withToolGroup(["device"], "device", false)).toEqual(["device"]);
  });
});

describe("TOOL_ACCESS_OPTIONS", () => {
  it("has a labelled, described switch for every group", () => {
    expect(TOOL_ACCESS_OPTIONS.map((option) => option.group)).toEqual([...AGENT_TOOL_GROUPS]);
    for (const option of TOOL_ACCESS_OPTIONS) {
      expect(option.label).toMatch(/^([A-Z][a-z]+)( [A-Z][a-z]+)*$/);
      expect(option.description.length).toBeGreaterThan(10);
    }
  });
});
