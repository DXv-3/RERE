import { describe, expect, it, vi } from "vite-plus/test";
import { createVoiceConversationProtocol, voiceUpdateChunks } from "./protocol.ts";
const speech = (id: string, delta: string) => ({
  type: "session.input_transcript.delta",
  event_id: id,
  delta,
});
const delegate = (id: string) => ({
  type: "session.delegation.created",
  delegation: { id, target: "client" },
});
describe("voice delegation", () => {
  it("collects fragments without submitting every fragment, then delegates context", () => {
    const send = vi.fn();
    const protocol = createVoiceConversationProtocol(send);
    protocol.receive(speech("1", "Build "));
    protocol.receive(speech("2", "the project"));
    expect(send).not.toHaveBeenCalled();
    protocol.receive(delegate("task"));
    expect(send).toHaveBeenCalledWith(
      "task",
      expect.stringContaining("New user speech since the last request:\nBuild the project"),
    );
  });
  it("does not repeat actions on duplicate events or repeated delegation", () => {
    const send = vi.fn();
    const protocol = createVoiceConversationProtocol(send);
    protocol.receive(speech("1", "Publish it"));
    protocol.receive(speech("1", "Publish it"));
    protocol.receive(delegate("task"));
    protocol.receive(delegate("task"));
    protocol.receive(delegate("other"));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps conversational context when a user redirects running work", () => {
    const send = vi.fn();
    const protocol = createVoiceConversationProtocol(send);
    protocol.receive(speech("1", "Make a blue header"));
    protocol.receive(delegate("first"));
    protocol.receive({ type: "session.output_transcript.delta", delta: "I'll start that." });
    protocol.receive(speech("2", "Actually, green"));
    protocol.receive(delegate("second"));
    expect(send.mock.calls[1]![0]).toBe("second");
    expect(send.mock.calls[1]![1]).toContain(
      "New user speech since the last request:\nActually, green",
    );
    expect(send.mock.calls[1]![1]).toContain("User: Make a blue header");
  });
  it("bounds history during long calls and ignores malformed events", () => {
    const send = vi.fn();
    const protocol = createVoiceConversationProtocol(send);
    protocol.receive(null);
    protocol.receive({ type: "session.delegation.created", delegation: {} });
    protocol.receive(speech("long", "a".repeat(24000)));
    protocol.receive(delegate("task"));
    expect(send.mock.calls[0]![1].length).toBeLessThanOrEqual(12000);
  });
  it("puts the current request before history so bounded routing reads the new instruction", () => {
    const send = vi.fn();
    const protocol = createVoiceConversationProtocol(send);
    protocol.receive(speech("old", "old context ".repeat(900)));
    protocol.receive(delegate("old-task"));
    protocol.receive(speech("new", "Create another agent"));
    protocol.receive(delegate("new-task"));
    expect(
      send.mock.calls[1]![1].startsWith(
        "New user speech since the last request:\nCreate another agent",
      ),
    ).toBe(true);
  });
  it("chunks unicode updates without breaking characters or the append limit", () => {
    const text = "🦊你好".repeat(250);
    const chunks = voiceUpdateChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((s) => new TextEncoder().encode(s).length <= 400)).toBe(true);
  });
});
