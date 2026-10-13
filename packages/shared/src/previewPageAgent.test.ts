// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  PREVIEW_PAGE_AGENT_MESSAGE_TYPE,
  previewPageAgentCall,
  previewPageAgentScript,
  previewPlaywrightInstallScript,
} from "./previewPageAgent.ts";

// The phone app ships the engine pre-generated; the test uses that same file.
const playwrightSource = (() => {
  const file = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../../../apps/mobile/src/features/browser/playwrightInjectedSource.generated.ts",
  );
  const text = NodeFS.readFileSync(file, "utf8");
  const match = /export const PLAYWRIGHT_INJECTED_SOURCE = (".*");\n?$/s.exec(text);
  if (!match) throw new Error("generated Playwright source not found");
  return JSON.parse(match[1]!) as string;
})();

type Reply = {
  readonly type: string;
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly tag: string; readonly message: string };
};

type PageWindow = Window &
  typeof globalThis & { eval: (code: string) => unknown; HTMLElement: typeof HTMLElement };
// Each test needs its own page, so build fresh ones with the JSDOM class vitest's environment
// exposes (its `jsdom` global), rather than importing jsdom, which ships no types.
const JSDOM = (
  globalThis as unknown as {
    jsdom: {
      constructor: new (
        html: string,
        options: { runScripts: "outside-only"; url: string },
      ) => { window: PageWindow };
    };
  }
).jsdom.constructor;

/** A page with the agent installed; `run` sends one command the way the host does. */
function page(html: string, options: { readonly playwright?: boolean } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`,
    {
      runScripts: "outside-only",
      url: "https://example.test/start",
    },
  );
  const window = dom.window;
  // jsdom has no layout; give every element a box so visibility checks see it.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      width: 100,
      height: 30,
      right: 110,
      bottom: 50,
      toJSON() {},
    };
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const replies: Reply[] = [];
  (window as unknown as { __cwPostMessage: (text: string) => void }).__cwPostMessage = (text) =>
    replies.push(JSON.parse(text) as Reply);
  if (options.playwright) window.eval(previewPlaywrightInstallScript(playwrightSource));
  window.eval(previewPageAgentScript());
  let next = 0;
  const run = async (operation: string, input: unknown): Promise<Reply> => {
    const id = `r${(next += 1)}`;
    window.eval(previewPageAgentCall(id, operation, input));
    return vi.waitFor(
      () => {
        const reply = replies.find((candidate) => candidate.id === id);
        if (!reply) throw new Error(`no reply to ${operation}`);
        return reply;
      },
      { timeout: 1_000, interval: 5 },
    );
  };
  return { window, run };
}

describe("previewPageAgent", () => {
  it("snapshots the page: identity, text, interactive elements and console output", async () => {
    const { window, run } = page(
      `<p>Welcome back</p><button id="send">Send</button><a href="/next" aria-label="Next page">→</a>`,
    );
    window.eval(`console.warn("careful")`);
    const reply = await run("snapshot", {});
    expect(reply.type).toBe(PREVIEW_PAGE_AGENT_MESSAGE_TYPE);
    expect(reply.ok).toBe(true);
    const value = reply.value as {
      url: string;
      title: string;
      visibleText: string;
      interactiveElements: Array<{ tag: string; name: string; selector: string }>;
      consoleEntries: Array<{ level: string; text: string }>;
    };
    expect(value.url).toBe("https://example.test/start");
    expect(value.title).toBe("Test");
    expect(value.visibleText).toContain("Welcome back");
    expect(value.interactiveElements).toEqual([
      expect.objectContaining({ tag: "button", name: "Send", selector: "#send" }),
      expect.objectContaining({ tag: "a", name: "Next page" }),
    ]);
    expect(value.consoleEntries).toEqual([
      expect.objectContaining({ level: "warning", text: "careful" }),
    ]);
  });

  it("clicks the element a selector names", async () => {
    const { window, run } = page(`<button id="go">Go</button><span id="out"></span>`);
    window.eval(
      `document.getElementById("go").addEventListener("click", () => { document.getElementById("out").textContent = "clicked"; })`,
    );
    expect((await run("click", { selector: "#go" })).ok).toBe(true);
    expect(window.document.getElementById("out")?.textContent).toBe("clicked");
  });

  it("types into a field so frameworks that listen for input see the change", async () => {
    const { window, run } = page(`<input id="name" value="Ry" />`);
    let seen = "";
    window.document.getElementById("name")?.addEventListener("input", (event: Event) => {
      seen = (event.target as HTMLInputElement).value;
    });
    window.eval(`document.getElementById("name").setSelectionRange(2, 2)`);
    expect((await run("type", { selector: "#name", text: "an" })).ok).toBe(true);
    expect(seen).toBe("Ryan");
    expect((await run("type", { selector: "#name", text: "Sam", clear: true })).ok).toBe(true);
    expect(seen).toBe("Sam");
  });

  it("refuses to type into something that is not a text field", async () => {
    const { run } = page(`<button id="b">B</button>`);
    const reply = await run("type", { selector: "#b", text: "x" });
    expect(reply.ok).toBe(false);
    expect(reply.error?.tag).toBe("PreviewAutomationTargetNotEditableError");
  });

  it("reports an invalid selector and a missing element differently", async () => {
    const { run } = page(`<p>hi</p>`);
    expect((await run("click", { selector: "p[" })).error?.tag).toBe(
      "PreviewAutomationInvalidSelectorError",
    );
    const missing = await run("click", { selector: "#nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error?.message).toContain("#nope");
  });

  it("submits a form on Enter in a field", async () => {
    const { window, run } = page(`<form id="f"><input id="q" /></form>`);
    let submitted = false;
    window.document.getElementById("f")?.addEventListener("submit", (event: Event) => {
      event.preventDefault();
      submitted = true;
    });
    window.eval(`document.getElementById("q").focus()`);
    expect((await run("press", { key: "Enter" })).ok).toBe(true);
    expect(submitted).toBe(true);
  });

  it("evaluates expressions, waits for promises, and refuses huge results", async () => {
    const { run } = page(`<p>x</p>`);
    expect((await run("evaluate", { expression: "1 + 2" })).value).toEqual({ value: 3 });
    expect((await run("evaluate", { expression: "Promise.resolve({ a: 1 })" })).value).toEqual({
      value: { a: 1 },
    });
    const huge = await run("evaluate", { expression: `"x".repeat(70000)` });
    expect(huge.error?.tag).toBe("PreviewAutomationResultTooLargeError");
  });

  it("waits for text to appear, and times out when it never does", async () => {
    const { window, run } = page(`<div id="d"></div>`);
    window.eval(`setTimeout(() => { document.getElementById("d").textContent = "Ready"; }, 30)`);
    expect((await run("waitFor", { selector: "#d:not(:empty)", timeoutMs: 2000 })).ok).toBe(true);
    const timedOut = await run("waitFor", { selector: "#never", timeoutMs: 50 });
    expect(timedOut.error?.tag).toBe("PreviewAutomationTimeoutError");
  });

  it("resolves Playwright locators with the same engine as the desktop", async () => {
    const { window, run } = page(
      `<button id="a">Cancel</button><button id="b">Send</button><span id="out"></span>`,
      { playwright: true },
    );
    expect(window.eval("typeof globalThis.__t3PlaywrightInjected")).toBe("object");
    window.eval(
      `document.getElementById("b").addEventListener("click", () => { document.getElementById("out").textContent = "sent"; })`,
    );
    expect((await run("click", { locator: "role=button[name='Send']" })).ok).toBe(true);
    expect(window.document.getElementById("out")?.textContent).toBe("sent");
    expect((await run("click", { locator: "text=Cancel" })).ok).toBe(true);
  });

  it("answers an operation it does not know with an error, not silence", async () => {
    const { run } = page(`<p>x</p>`);
    const reply = await run("resize", {});
    expect(reply.ok).toBe(false);
  });
});
