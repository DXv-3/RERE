import { MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyAgentInstructions,
  originalSessionRequest,
  parseAgent,
  sessionKey,
  splitAgentMessage,
  summarizePurpose,
  useWorkbenchPreferences,
  type AgentProfile,
} from "./workbenchPreferences";
const agent: AgentProfile = {
  id: "builder",
  name: "Builder",
  description: "Build websites",
  instructions: "Run relevant tests. Keep changes scoped.",
  color: "#22c55e",
  pinned: true,
  projectKey: "project",
  runtimeMode: "inherit",
  modelSelection: null,
};
beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  useWorkbenchPreferences.setState({
    agents: [],
    assignments: {},
    lastConversations: {},
    purposes: {},
    dismissedAttention: {},
    storageError: null,
  });
});
describe("agent profiles and session purpose", () => {
  it("retains the original request across follow-ups and reload", async () => {
    const key = sessionKey("one", "thread");
    useWorkbenchPreferences
      .getState()
      .rememberPurpose(key, "Create a client gallery with protected downloads.");
    useWorkbenchPreferences.getState().rememberPurpose(key, "Now change the button color.");
    await useWorkbenchPreferences.persist.rehydrate();
    expect(useWorkbenchPreferences.getState().purposes[key]?.text).toBe(
      "Create a client gallery with protected downloads.",
    );
    expect(
      useWorkbenchPreferences.getState().purposes[sessionKey("two", "thread")],
    ).toBeUndefined();
  });
  it("remembers each agent's open conversation across a reload and ignores bad stored values", async () => {
    const key = sessionKey("one", "agent-a");
    useWorkbenchPreferences.getState().rememberConversation(key, "thread-2");
    await useWorkbenchPreferences.persist.rehydrate();
    expect(useWorkbenchPreferences.getState().lastConversations[key]).toBe("thread-2");
    localStorage.setItem(
      "workbench:profiles:v1",
      JSON.stringify({ state: { lastConversations: { [key]: 5, other: "t" } }, version: 0 }),
    );
    await useWorkbenchPreferences.persist.rehydrate();
    expect(useWorkbenchPreferences.getState().lastConversations).toEqual({ other: "t" });
  });
  it("refreshes agent instructions without nesting them and preserves slash commands", () => {
    const first = applyAgentInstructions("Build a gallery", agent);
    expect(first).toContain(agent.instructions);
    const updated = applyAgentInstructions(first, {
      ...agent,
      instructions: "Use the new design.",
    });
    expect(updated).not.toContain(agent.instructions);
    expect(updated.match(/<workbench-agent>/g)).toHaveLength(1);
    expect(updated).toContain("Build a gallery");
    expect(applyAgentInstructions("/compact", agent)).toBe("/compact");
    expect(summarizePurpose(first)).toBe("Build a gallery");
  });
  it("keeps profile instructions separate from the visible original request", () => {
    const request = "Build a gallery\nPreserve the existing design.";
    const wrapped = applyAgentInstructions(request, agent);
    expect(splitAgentMessage(wrapped)).toEqual({
      instructions: `Agent: ${agent.name}\n${agent.instructions}`,
      request,
    });
    expect(splitAgentMessage(request)).toEqual({ instructions: null, request });
  });
  it("saves real profiles, scopes assignments, and removes associations without deleting purposes", async () => {
    const key = sessionKey("one", "thread");
    const prefs = useWorkbenchPreferences.getState();
    prefs.saveAgent(agent);
    prefs.assign(key, agent.id);
    prefs.rememberPurpose(key, "Keep this goal");
    await useWorkbenchPreferences.persist.rehydrate();
    expect(useWorkbenchPreferences.getState().agents[0]).toEqual(agent);
    expect(useWorkbenchPreferences.getState().assignments[key]).toBe(agent.id);
    useWorkbenchPreferences.getState().removeAgent(agent.id);
    expect(useWorkbenchPreferences.getState().assignments[key]).toBeUndefined();
    expect(useWorkbenchPreferences.getState().purposes[key]?.text).toBe("Keep this goal");
  });
  it("rejects malformed saved profiles and clamps unsupported settings", () => {
    expect(parseAgent({ name: "" })).toBeNull();
    expect(
      parseAgent({
        ...agent,
        runtimeMode: "root",
        color: "url(evil)",
        modelSelection: { bad: true },
      }),
    ).toMatchObject({ runtimeMode: "inherit", color: "#22c55e", modelSelection: null });
  });
  it("keeps the tool groups an owner switched off and drops unknown ones", () => {
    expect(
      parseAgent({ ...agent, blockedToolGroups: ["worktree", "bogus", "preview"] }),
    ).toMatchObject({ blockedToolGroups: ["preview", "worktree"] });
    expect(parseAgent({ ...agent, blockedToolGroups: [] })).toMatchObject({
      blockedToolGroups: [],
    });
    expect(parseAgent(agent)).not.toHaveProperty("blockedToolGroups");
  });
  it("does not invent a summary or store a compact command as the original goal", () => {
    useWorkbenchPreferences.getState().rememberPurpose("x", "/compact");
    expect(useWorkbenchPreferences.getState().purposes.x).toBeUndefined();
    expect(summarizePurpose("a ".repeat(300)).length).toBeLessThanOrEqual(420);
  });
});

describe("original requests from imported and paged history", () => {
  const original = {
    id: MessageId.make("old"),
    role: "user" as const,
    text: "Original imported goal",
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  };
  const recent = {
    ...original,
    id: MessageId.make("new"),
    text: "Continue with another detail",
    createdAt: DateTime.makeUnsafe("2026-10-03T00:00:00Z"),
  };
  const runs = [{ ordinal: 1, userMessageId: recent.id }];
  it("does not mistake the first local continuation for an imported session's original goal", () => {
    expect(
      originalSessionRequest({ imported: true, hasMoreHistory: true, messages: [recent], runs }),
    ).toBeNull();
    expect(
      originalSessionRequest({
        imported: true,
        hasMoreHistory: false,
        messages: [recent, original],
        runs,
      }),
    ).toBe(original.text);
  });
  it("can recover a known first local run without labeling a recent page as the beginning", () => {
    expect(
      originalSessionRequest({ imported: false, hasMoreHistory: true, messages: [recent], runs }),
    ).toBe(recent.text);
    expect(
      originalSessionRequest({
        imported: false,
        hasMoreHistory: true,
        messages: [recent],
        runs: [],
      }),
    ).toBeNull();
  });
});
