import { describe, expect, it } from "vite-plus/test";

import {
  applyAgentInput,
  applyAgentReport,
  createAgentStatusScanner,
  NO_AGENT_STATUS,
} from "./AgentStatus.ts";

const hook = (state: string) => `\x1b]9001;${state}\x07`;

describe("createAgentStatusScanner", () => {
  it("reads a hook report from the middle of other output", () => {
    const scan = createAgentStatusScanner();
    expect(scan(`hello ${hook("working")} world`)).toEqual({ state: "working", source: "hook" });
    expect(scan("plain output")).toBeNull();
  });

  it("returns the last report when a chunk carries several", () => {
    const scan = createAgentStatusScanner();
    expect(scan(hook("working") + hook("needs-you"))?.state).toBe("needs-you");
  });

  it("completes a report split across chunks, including a split terminator", () => {
    const scan = createAgentStatusScanner();
    expect(scan("text\x1b")).toBeNull();
    expect(scan("]9001;id")).toBeNull();
    expect(scan("le\x1b")).toBeNull();
    expect(scan("\\more")).toEqual({ state: "idle", source: "hook" });
  });

  it("ignores window titles, unknown states and terminal commands on OSC 9", () => {
    const scan = createAgentStatusScanner();
    expect(scan("\x1b]0;my title\x07")).toBeNull();
    expect(scan(hook("dancing"))).toBeNull();
    expect(scan("\x1b]9;4;1;50\x07")).toBeNull();
  });

  it("reads a notification as a finished turn, or a wait when it asks for approval", () => {
    const scan = createAgentStatusScanner();
    expect(scan("\x1b]9;All done, tests pass\x07")).toEqual({
      state: "idle",
      source: "notification",
    });
    expect(scan("\x1b]9;Approval requested: rm -rf build\x07")?.state).toBe("needs-you");
  });

  it("gives up on a sequence that never ends", () => {
    const scan = createAgentStatusScanner();
    expect(scan(`\x1b]9;${"x".repeat(2000)}`)).toBeNull();
    expect(scan(`\x07${hook("idle")}`)?.state).toBe("idle");
  });
});

describe("agent status transitions", () => {
  const notified = { state: "idle", source: "notification" } as const;
  const hooked = { state: "working", source: "hook" } as const;

  it("keeps a hook report over a later notification", () => {
    expect(applyAgentReport(hooked, notified)).toBe(hooked);
    expect(applyAgentReport(notified, hooked)).toBe(hooked);
    expect(applyAgentReport(NO_AGENT_STATUS, notified)).toBe(notified);
  });

  it("clears a notified idle on Enter and a notified wait on any key", () => {
    expect(applyAgentInput(notified, "fix the bug")).toBe(notified);
    expect(applyAgentInput(notified, "\r").state).toBeNull();
    expect(applyAgentInput({ state: "needs-you", source: "notification" }, "y").state).toBeNull();
  });

  it("leaves hook-reported status alone when the user types", () => {
    expect(applyAgentInput({ state: "idle", source: "hook" }, "\r").state).toBe("idle");
  });
});
