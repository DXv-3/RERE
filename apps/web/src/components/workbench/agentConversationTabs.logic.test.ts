import { describe, expect, it } from "vite-plus/test";
import {
  agentTabTitle,
  buildAgentConversationTabs,
  nextTabIndex,
  resolveAgentTabDot,
  resolveRememberedConversation,
  selectAfterClose,
  truncateTabTitle,
  type AgentTabThread,
  agentThreadsAfterClose,
} from "./agentConversationTabs.logic";

const thread = (id: string, over: Partial<AgentTabThread> = {}): AgentTabThread => ({
  id,
  title: `Title ${id}`,
  status: "ready",
  isUnread: false,
  ...over,
});

describe("buildAgentConversationTabs", () => {
  it("puts the primary first, keeps record order and drops archived or unknown threads", () => {
    const tabs = buildAgentConversationTabs({
      agentName: "Scout",
      primaryThreadId: "agent:scout",
      threadIds: ["b", "gone", "a", "agent:scout", "b"],
      threads: [
        thread("a"),
        thread("b"),
        thread("agent:scout"),
        thread("old", { archivedAt: "2026-01-01" }),
        thread("archived-listed", { archivedAt: "2026-01-01" }),
      ],
    });
    expect(tabs.map((t) => t.id)).toEqual(["agent:scout", "b", "a"]);
    // Every tab can be closed while another remains, the main one included.
    expect(tabs.map((t) => t.closable)).toEqual([true, true, true]);
  });

  it("leaves out an archived primary rather than closing it", () => {
    const tabs = buildAgentConversationTabs({
      agentName: "Scout",
      primaryThreadId: "p",
      threadIds: ["a"],
      threads: [thread("p", { archivedAt: "x" }), thread("a")],
    });
    expect(tabs.map((t) => t.id)).toEqual(["a"]);
  });

  it("carries the full title and a shortened label", () => {
    const long = "Refactor the invoice export so totals match the ledger";
    const [tab] = buildAgentConversationTabs({
      agentName: "Scout",
      primaryThreadId: "p",
      threadIds: [],
      threads: [thread("p", { title: long })],
    });
    expect(tab?.fullTitle).toBe(long);
    expect(tab?.label.length).toBeLessThanOrEqual(28);
    expect(tab?.label.endsWith("…")).toBe(true);
  });
});

describe("titles", () => {
  it("cuts only past the limit and collapses whitespace", () => {
    expect(truncateTabTitle("  short   title ")).toBe("short title");
    expect(truncateTabTitle("x".repeat(28))).toBe("x".repeat(28));
    expect(truncateTabTitle("x".repeat(29))).toBe(`${"x".repeat(27)}…`);
  });

  it("calls an additional conversation still named after the agent a new chat", () => {
    expect(agentTabTitle({ title: "Scout", agentName: "Scout", isPrimary: false })).toBe(
      "New chat",
    );
    expect(agentTabTitle({ title: "", agentName: "Scout", isPrimary: false })).toBe("New chat");
    expect(agentTabTitle({ title: "Scout", agentName: "Scout", isPrimary: true })).toBe("Scout");
    expect(agentTabTitle({ title: "Fix it", agentName: "Scout", isPrimary: false })).toBe("Fix it");
  });
});

describe("resolveAgentTabDot", () => {
  it("maps the sidebar status the way the team board does", () => {
    expect(resolveAgentTabDot("approval", false)).toBe("needs-you");
    expect(resolveAgentTabDot("input", false)).toBe("needs-you");
    expect(resolveAgentTabDot("working", false)).toBe("working");
    expect(resolveAgentTabDot("waiting", false)).toBe("working");
    expect(resolveAgentTabDot("failed", false)).toBe("failed");
    expect(resolveAgentTabDot("limited", false)).toBe("failed");
    expect(resolveAgentTabDot("ready", true)).toBe("done");
    expect(resolveAgentTabDot("ready", false)).toBeNull();
  });
});

describe("selectAfterClose", () => {
  const tabIds = ["p", "a", "b", "c"];
  it("keeps the open tab when another one is closed", () => {
    expect(selectAfterClose({ tabIds, closedId: "b", activeId: "a" })).toBe("a");
  });
  it("moves to the left neighbour when the open tab is closed", () => {
    expect(selectAfterClose({ tabIds, closedId: "b", activeId: "b" })).toBe("a");
    expect(selectAfterClose({ tabIds, closedId: "c", activeId: "c" })).toBe("b");
    expect(selectAfterClose({ tabIds, closedId: "a", activeId: "a" })).toBe("p");
  });
  it("handles an unknown or lone tab", () => {
    expect(selectAfterClose({ tabIds, closedId: "zz", activeId: "zz" })).toBe("p");
    expect(selectAfterClose({ tabIds: ["a"], closedId: "a", activeId: "a" })).toBeNull();
  });
});

describe("resolveRememberedConversation", () => {
  const base = { tabIds: ["p", "a"], primaryThreadId: "p" };
  it("reopens the remembered conversation while it has a tab", () => {
    expect(resolveRememberedConversation({ ...base, remembered: "a" })).toBe("a");
  });
  it("falls back to the primary when it is gone or nothing was remembered", () => {
    expect(resolveRememberedConversation({ ...base, remembered: "closed" })).toBe("p");
    expect(resolveRememberedConversation({ ...base, remembered: undefined })).toBe("p");
    expect(
      resolveRememberedConversation({ tabIds: [], remembered: "a", primaryThreadId: null }),
    ).toBeNull();
  });
});

describe("nextTabIndex", () => {
  it("wraps arrows and jumps with Home and End", () => {
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
    expect(nextTabIndex("a", 0, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("agentThreadsAfterClose", () => {
  it("hands the main role to the first conversation left when the main one closes", () => {
    expect(
      agentThreadsAfterClose({
        primaryThreadId: "a",
        threadIds: ["a", "b", "c"],
        tabIds: ["a", "b", "c"],
        closedId: "a",
      }),
    ).toEqual({ primaryThreadId: "b", threadIds: ["b", "c"], primaryChanged: true });
  });

  it("leaves the main conversation alone when another one closes", () => {
    expect(
      agentThreadsAfterClose({
        primaryThreadId: "a",
        threadIds: ["a", "b"],
        tabIds: ["a", "b"],
        closedId: "b",
      }),
    ).toEqual({ primaryThreadId: "a", threadIds: ["a"], primaryChanged: false });
  });
});
