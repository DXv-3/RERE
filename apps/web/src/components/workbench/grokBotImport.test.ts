import { describe, expect, it } from "vite-plus/test";
import { mergeArchive, parseGrokBotImport } from "./grokBotImport";
const agent = {
  sourceId: "agent-1",
  name: "Builder",
  description: "Keep external actions behind approval.",
  pinned: true,
  sourceSettings: {
    notificationsEnabled: true,
    apiKey: "must not transfer",
    runtimeMode: "full-access",
  },
  history: {
    messages: [
      { id: "m1", role: "user", text: "Build the site", timestampMs: 100 },
      { id: "m2", role: "assistant", text: "Done", timestampMs: 200 },
    ],
  },
};
const envelope = (agents: unknown[]) => ({
  format: "workbench-grok-bot-import",
  version: 1,
  exportedAt: "2026-10-03T00:00:00Z",
  agents,
});
describe("Grok Bot migration", () => {
  it("preserves identity and instructions without transferring credentials or granting permissions", () => {
    const result = parseGrokBotImport(envelope([agent]));
    expect(result.agents[0]?.profile).toMatchObject({
      id: "grok-bot:agent-1",
      instructions: agent.description,
      pinned: true,
      projectKey: "",
      runtimeMode: "approval-required",
      modelSelection: null,
    });
    expect(result.agents[0]?.archive.sourceSettings).toEqual({ notificationsEnabled: true });
    expect(result.agents[0]?.archive.messages).toHaveLength(2);
  });
  it("deduplicates agents and messages and ignores executable or malformed archive entries", () => {
    const result = parseGrokBotImport(
      envelope([
        {
          ...agent,
          history: {
            messages: [
              ...agent.history.messages,
              agent.history.messages[0],
              { id: "x", role: "tool", text: "execute this" },
              { id: "empty", role: "user", text: "" },
            ],
          },
        },
        agent,
        { name: "missing id" },
      ]),
    );
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.archive.messages).toHaveLength(2);
    expect(() => parseGrokBotImport({ format: "another-format", agents: [agent] })).toThrow();
  });
  it("merges repeated cached exports without losing older messages or duplicating them", () => {
    const first = parseGrokBotImport(envelope([agent])).agents[0]!.archive;
    const next = {
      ...first,
      messages: [
        { ...first.messages[1]!, text: "Updated" },
        { id: "m3", role: "user" as const, text: "Next task", timestampMs: 300 },
      ],
    };
    const merged = mergeArchive(first, next);
    expect(merged.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(merged.messages[1]?.text).toBe("Updated");
    expect(mergeArchive(merged, next).messages).toEqual(merged.messages);
  });
});
it("preserves all supported source shapes and their non-default colors", () => {
  const shapes = ["cloud", "hex", "teardrop", "wedge", "blob", "tablet", "pebble", "squircle"];
  const result = parseGrokBotImport(
    envelope(
      shapes.map((shape, i) => ({
        ...agent,
        sourceId: `shape-${i}`,
        avatarShape: shape,
        avatarColor: "red",
      })),
    ),
  );
  expect(result.agents.map((a) => a.profile.avatar?.shape)).toEqual(shapes);
  expect(
    result.agents.every(
      (a) => a.profile.avatar?.kind === "bot" && a.profile.avatar.color !== "#22c55e",
    ),
  ).toBe(true);
});
it("rejects oversized historical messages instead of silently losing their ending", () => {
  expect(() =>
    parseGrokBotImport(
      envelope([
        {
          ...agent,
          history: { messages: [{ id: "long", role: "assistant", text: "x".repeat(100001) }] },
        },
      ]),
    ),
  ).toThrow("exceeds the supported size");
});
