// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  chatGlobalInputOwner,
  ownsChatGlobalInput,
  routeOwnsChatGlobalInput,
} from "./chatInputOwnership";

afterEach(() => {
  document.body.replaceChildren();
});

function chat(threadId: string, hidden = false) {
  const wrapper = document.createElement("div");
  wrapper.hidden = hidden;
  if (hidden) wrapper.setAttribute("inert", "");
  const root = document.createElement("div");
  root.dataset.wbChat = "";
  root.dataset.chatThreadId = threadId;
  root.dataset.chatEnvironmentId = "env";
  const editor = document.createElement("textarea");
  root.append(editor);
  wrapper.append(root);
  document.body.append(wrapper);
  return { root, editor, wrapper };
}

describe("global chat input ownership", () => {
  it.each(["different-thread", "same-thread"])(
    "delivers body paste exactly once with a hidden route and %s Studio",
    (thread) => {
      const route = chat("same-thread", true);
      const studio = chat(thread);
      const hiddenDraft = vi.fn();
      const visibleDraft = vi.fn();
      const hiddenListener = (event: Event) => {
        if (ownsChatGlobalInput(route.root, event.target)) hiddenDraft();
      };
      const visibleListener = (event: Event) => {
        if (ownsChatGlobalInput(studio.root, event.target)) visibleDraft();
      };
      // Match the long-lived route listener preceding the newly mounted Studio listener.
      window.addEventListener("paste", hiddenListener, true);
      window.addEventListener("paste", visibleListener, true);
      try {
        document.body.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
      } finally {
        window.removeEventListener("paste", hiddenListener, true);
        window.removeEventListener("paste", visibleListener, true);
      }
      expect(hiddenDraft).not.toHaveBeenCalled();
      expect(visibleDraft).toHaveBeenCalledOnce();
    },
  );
  it("gives stash and thread shortcuts to the focused visible chat only", () => {
    const first = chat("one");
    const second = chat("two");
    first.editor.focus();
    expect(ownsChatGlobalInput(first.root, first.editor)).toBe(true);
    expect(ownsChatGlobalInput(second.root, first.editor)).toBe(false);
    second.editor.focus();
    expect(chatGlobalInputOwner(document.body)).toBe(second.root);
    expect(routeOwnsChatGlobalInput({ environmentId: "env", threadId: "one" }, second.editor)).toBe(
      false,
    );
    expect(routeOwnsChatGlobalInput({ environmentId: "env", threadId: "two" }, second.editor)).toBe(
      true,
    );
  });
  it("does not guess when two visible chats have no focus owner", () => {
    const first = chat("one");
    const second = chat("two");
    expect(chatGlobalInputOwner(document.body)).toBeNull();
    expect(ownsChatGlobalInput(first.root, document.body)).toBe(false);
    expect(ownsChatGlobalInput(second.root, document.body)).toBe(false);
  });
  it("rejects hidden, inert, detached and CSS-invisible chat roots", () => {
    const pane = chat("one");
    pane.wrapper.setAttribute("inert", "");
    expect(ownsChatGlobalInput(pane.root, pane.editor)).toBe(false);
    pane.wrapper.removeAttribute("inert");
    pane.wrapper.hidden = true;
    expect(ownsChatGlobalInput(pane.root, pane.editor)).toBe(false);
    pane.wrapper.hidden = false;
    pane.root.checkVisibility = () => false;
    expect(ownsChatGlobalInput(pane.root, pane.editor)).toBe(false);
    pane.root.checkVisibility = () => true;
    pane.wrapper.remove();
    expect(ownsChatGlobalInput(pane.root, pane.editor)).toBe(false);
  });
  it("retains empty-route shortcuts but never targets a hidden route behind Studio", () => {
    expect(routeOwnsChatGlobalInput(null, document.body)).toBe(true);
    const route = chat("route", true);
    expect(
      routeOwnsChatGlobalInput({ environmentId: "env", threadId: "route" }, document.body),
    ).toBe(false);
    const studio = chat("studio");
    expect(
      routeOwnsChatGlobalInput({ environmentId: "env", threadId: "route" }, studio.editor),
    ).toBe(false);
    route.wrapper.hidden = false;
    route.wrapper.removeAttribute("inert");
    studio.wrapper.remove();
    expect(
      routeOwnsChatGlobalInput({ environmentId: "env", threadId: "route" }, route.editor),
    ).toBe(true);
  });
});
