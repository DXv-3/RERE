import { describe, expect, it } from "vite-plus/test";

import { agentKickoffMessage } from "./agentKickoff.ts";

describe("agentKickoffMessage", () => {
  it("starts an agent that has instructions and asks it to report back", () => {
    const message = agentKickoffMessage({ instructions: "Find skills worth adopting." });
    expect(message).toContain("Start on your purpose now");
    expect(message).toContain("report what you did");
  });

  it("does not start an agent that has nothing to work from", () => {
    expect(agentKickoffMessage({ instructions: "" })).toBeNull();
    expect(agentKickoffMessage({ instructions: "   \n" })).toBeNull();
  });
});
