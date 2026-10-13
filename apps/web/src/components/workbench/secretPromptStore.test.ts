import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { pickSecretRequest, secretRequestKey, useSecretPromptStore } from "./secretPromptStore";

describe("secretPromptStore", () => {
  it("does not detach a new conversation when the previous host cleans up", () => {
    const previous = {} as HTMLDivElement;
    const current = {} as HTMLDivElement;
    const store = useSecretPromptStore.getState();
    const identity = {
      environmentId: EnvironmentId.make("server"),
      threadId: ThreadId.make("thread"),
    };
    store.setHost({ ...identity, element: previous });
    store.setHost({ ...identity, element: current });
    store.clearHost(previous);
    expect(useSecretPromptStore.getState().host?.element).toBe(current);
    store.clearHost(current);
    expect(useSecretPromptStore.getState().host).toBeNull();
  });
  it("remembers which requests were closed, per environment, and can reopen them", () => {
    const { dismiss, reopen } = useSecretPromptStore.getState();
    const first = secretRequestKey("environment:a", "req-1");
    const second = secretRequestKey("environment:b", "req-1");
    dismiss(first);
    dismiss(second);
    expect(useSecretPromptStore.getState().dismissed.has(first)).toBe(true);
    reopen([first]);
    expect(useSecretPromptStore.getState().dismissed.has(first)).toBe(false);
    // The same request id in another environment is a different request.
    expect(useSecretPromptStore.getState().dismissed.has(second)).toBe(true);
    reopen([second]);
  });
});

describe("pickSecretRequest", () => {
  const entry = (id: string, threadId: string, environmentId = "server") => ({
    environmentId,
    request: { id, threadId },
  });
  const host = { environmentId: "server", threadId: "thread-lead" };

  it("shows a teammate's request inside the conversation on screen", () => {
    // The teammate asks from its own thread while the owner is looking at the lead agent's.
    const picked = pickSecretRequest([entry("r1", "thread-teammate")], host);
    expect(picked).toEqual({
      current: entry("r1", "thread-teammate"),
      inline: true,
      elsewhere: true,
    });
  });
  it("puts the conversation's own request ahead of older ones from elsewhere", () => {
    const picked = pickSecretRequest(
      [entry("r1", "thread-teammate"), entry("r2", "thread-lead")],
      host,
    );
    expect(picked?.current.request.id).toBe("r2");
    expect(picked?.elsewhere).toBe(false);
  });
  it("does not treat the same thread id on another machine as this conversation", () => {
    expect(pickSecretRequest([entry("r1", "thread-lead", "mac")], host)?.elsewhere).toBe(true);
  });
  it("falls back to the dialog only when no conversation is on screen", () => {
    expect(pickSecretRequest([entry("r1", "thread-teammate")], null)).toEqual({
      current: entry("r1", "thread-teammate"),
      inline: false,
      elsewhere: false,
    });
  });
  it("shows nothing when nothing is waiting", () => {
    expect(pickSecretRequest([], host)).toBeNull();
  });
});
