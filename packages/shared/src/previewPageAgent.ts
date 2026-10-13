/**
 * The script a browser host without DevTools injects into every page, so agents' preview tools can
 * run there: the phone app's WebView is the one host that uses it. It is plain JavaScript kept as a
 * string because React Native's Hermes engine cannot turn a compiled function back into source.
 *
 * The page answers one command at a time: `window.__cwPageAgent.run(id, operation, input)` posts
 * `{ type: "cw-agent-result", id, ok, value }` or `{ ..., ok: false, error: { tag, message } }`
 * through `postMessage`. Element lookups use Playwright's injected engine when the host installed
 * it as `globalThis.__t3PlaywrightInjected`, the same engine the desktop uses, so locators such as
 * `role=button[name='Send']` mean the same thing on both hosts; plain CSS works without it.
 *
 * Input is synthetic DOM events, not real taps: a page that only accepts trusted input will not
 * respond to them.
 */

/** Same caps as the desktop snapshot, so both hosts return pages of the same shape. */
const PREVIEW_PAGE_AGENT_LIMITS = {
  visibleText: 20_000,
  interactiveElements: 200,
  elementName: 200,
  consoleEntries: 100,
  consoleText: 2_000,
  evaluateResultChars: 64_000,
} as const;

export const PREVIEW_PAGE_AGENT_MESSAGE_TYPE = "cw-agent-result";

const LIMITS = JSON.stringify(PREVIEW_PAGE_AGENT_LIMITS);

/**
 * Installs the console recorder and the command runner. Safe to run more than once; run it before
 * the page's own scripts when the host allows (`injectedJavaScriptBeforeContentLoaded`) so early
 * console output is kept.
 */
export function previewPageAgentScript(): string {
  return `(function () {
  if (window.__cwPageAgent) return true;
  var LIMITS = ${LIMITS};
  var MESSAGE_TYPE = ${JSON.stringify(PREVIEW_PAGE_AGENT_MESSAGE_TYPE)};
  var consoleEntries = [];
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        var text = Array.prototype.map.call(arguments, function (value) {
          if (typeof value === "string") return value;
          try { return JSON.stringify(value); } catch (error) { return String(value); }
        }).join(" ");
        consoleEntries.push({
          level: level === "warn" ? "warning" : level,
          text: text.slice(0, LIMITS.consoleText),
          timestamp: new Date().toISOString(),
          source: "console"
        });
        if (consoleEntries.length > LIMITS.consoleEntries) consoleEntries.shift();
      } catch (error) {}
      if (original) return original.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (event) {
    consoleEntries.push({
      level: "error",
      text: String(event.message || "Script error").slice(0, LIMITS.consoleText),
      timestamp: new Date().toISOString(),
      source: "exception"
    });
    if (consoleEntries.length > LIMITS.consoleEntries) consoleEntries.shift();
  });

  function post(message) {
    var text = JSON.stringify(message);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(text);
    else if (window.__cwPostMessage) window.__cwPostMessage(text);
  }
  function fail(tag, message) {
    var error = new Error(message);
    error.cwTag = tag;
    return error;
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\\\" + c; });
  }
  function selectorFor(element) {
    if (element.id) return "#" + cssEscape(element.id);
    var attributes = ["data-testid", "name"];
    for (var i = 0; i < attributes.length; i++) {
      var value = element.getAttribute(attributes[i]);
      if (value) return element.tagName.toLowerCase() + "[" + attributes[i] + "=" + JSON.stringify(value) + "]";
    }
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && parts.length < 8) {
      var parent = current.parentElement;
      var tag = current.tagName;
      var siblings = parent ? Array.prototype.filter.call(parent.children, function (child) { return child.tagName === tag; }) : [];
      var base = tag.toLowerCase();
      parts.unshift(siblings.length > 1 ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : base);
      current = parent;
    }
    return parts.join(" > ");
  }
  function isVisible(element) {
    var style = getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }
  function elementName(element) {
    return (element.getAttribute("aria-label") || element.innerText || element.textContent || element.getAttribute("name") || element.getAttribute("placeholder") || "")
      .replace(/\\s+/g, " ").trim().slice(0, LIMITS.elementName);
  }

  function resolveTarget(input, required) {
    var element = null;
    if (input.locator) {
      var injected = globalThis.__t3PlaywrightInjected;
      if (injected) {
        var parsed;
        try { parsed = injected.parseSelector(input.locator); }
        catch (error) { throw fail("PreviewAutomationInvalidSelectorError", "Invalid locator: " + input.locator); }
        element = injected.querySelector(parsed, document, false) || null;
      } else {
        try { element = document.querySelector(input.locator); }
        catch (error) { throw fail("PreviewAutomationInvalidSelectorError", "Invalid locator: " + input.locator); }
      }
    } else if (input.selector) {
      try { element = document.querySelector(input.selector); }
      catch (error) { throw fail("PreviewAutomationInvalidSelectorError", "Invalid selector: " + input.selector); }
    } else if (typeof input.x === "number" && typeof input.y === "number") {
      element = document.elementFromPoint(input.x, input.y);
    }
    if (!element && required) {
      throw fail("PreviewAutomationTargetNotFoundError", "No element matches " + (input.locator || input.selector || ("(" + input.x + ", " + input.y + ")")) + ".");
    }
    return element;
  }

  function center(element) {
    var rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  function pointer(type, element, point) {
    var init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: point.x, clientY: point.y, button: 0, buttons: type.indexOf("down") >= 0 ? 1 : 0 };
    var Constructor = type.indexOf("pointer") === 0 && window.PointerEvent ? PointerEvent : MouseEvent;
    if (Constructor === window.PointerEvent) { init.pointerId = 1; init.pointerType = "touch"; init.isPrimary = true; }
    element.dispatchEvent(new Constructor(type, init));
  }

  function isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (element.tagName === "TEXTAREA") return !element.readOnly && !element.disabled;
    if (element.tagName === "INPUT") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      return ["button", "checkbox", "radio", "submit", "reset", "file", "image", "hidden", "range", "color"].indexOf(type) < 0 && !element.readOnly && !element.disabled;
    }
    return false;
  }
  function setNativeValue(element, value) {
    var prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function snapshot() {
    var candidates = document.querySelectorAll("a[href],button,input,textarea,select,[role],[tabindex],[contenteditable='true']");
    var interactive = [];
    for (var i = 0; i < candidates.length && interactive.length < LIMITS.interactiveElements; i++) {
      var element = candidates[i];
      if (!isVisible(element)) continue;
      var rect = element.getBoundingClientRect();
      interactive.push({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: elementName(element),
        selector: selectorFor(element),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height
      });
    }
    return {
      url: location.href,
      title: document.title,
      loading: document.readyState !== "complete",
      visibleText: ((document.body && (document.body.innerText || document.body.textContent)) || "").slice(0, LIMITS.visibleText),
      interactiveElements: interactive,
      consoleEntries: consoleEntries.slice()
    };
  }

  function click(input) {
    var element = resolveTarget(input, true);
    if (element.scrollIntoView) element.scrollIntoView({ block: "center", inline: "center" });
    var point = (typeof input.x === "number" && typeof input.y === "number" && !input.locator && !input.selector) ? { x: input.x, y: input.y } : center(element);
    pointer("pointerdown", element, point);
    pointer("mousedown", element, point);
    if (element.focus) element.focus();
    pointer("pointerup", element, point);
    pointer("mouseup", element, point);
    if (element.click) element.click();
    else pointer("click", element, point);
    return { clicked: true };
  }

  function type(input) {
    var element = (input.locator || input.selector) ? resolveTarget(input, true) : document.activeElement;
    if (!isEditable(element)) throw fail("PreviewAutomationTargetNotEditableError", "The target is not a text field.");
    if (element.focus) element.focus();
    if (element.isContentEditable) {
      if (input.clear) element.textContent = "";
      if (!document.execCommand || !document.execCommand("insertText", false, input.text)) element.textContent += input.text;
    } else {
      var start = input.clear ? 0 : (element.selectionStart != null ? element.selectionStart : element.value.length);
      var end = input.clear ? element.value.length : (element.selectionEnd != null ? element.selectionEnd : element.value.length);
      var next = element.value.slice(0, start) + input.text + element.value.slice(end);
      setNativeValue(element, next);
      try { element.setSelectionRange(start + input.text.length, start + input.text.length); } catch (error) {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: input.text, inputType: "insertText" }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: true };
  }

  function press(input) {
    var element = document.activeElement || document.body;
    var modifiers = input.modifiers || [];
    var init = { key: input.key, bubbles: true, cancelable: true, composed: true,
      altKey: modifiers.indexOf("Alt") >= 0, ctrlKey: modifiers.indexOf("Control") >= 0,
      metaKey: modifiers.indexOf("Meta") >= 0, shiftKey: modifiers.indexOf("Shift") >= 0 };
    var proceed = element.dispatchEvent(new KeyboardEvent("keydown", init));
    if (proceed) {
      if (input.key === "Enter" && element.form && element.tagName === "INPUT") {
        if (element.form.requestSubmit) element.form.requestSubmit(); else element.form.submit();
      } else if (input.key === "Backspace" && isEditable(element) && !element.isContentEditable) {
        var s = element.selectionStart, e = element.selectionEnd;
        if (s != null) {
          var from = s === e ? Math.max(0, s - 1) : s;
          setNativeValue(element, element.value.slice(0, from) + element.value.slice(e));
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        }
      } else if (input.key === "Tab") {
        var focusable = Array.prototype.filter.call(document.querySelectorAll("a[href],button,input,textarea,select,[tabindex]"), isVisible);
        var index = focusable.indexOf(element);
        var nextElement = focusable[init.shiftKey ? index - 1 : index + 1];
        if (nextElement && nextElement.focus) nextElement.focus();
      } else if (input.key.length === 1 && isEditable(element) && !init.ctrlKey && !init.metaKey) {
        type({ text: input.key });
      }
    }
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    return { pressed: true };
  }

  function scroll(input) {
    var dx = input.deltaX || 0, dy = input.deltaY || 0;
    var element = (input.locator || input.selector) ? resolveTarget(input, true) : null;
    if (element) element.scrollBy(dx, dy); else window.scrollBy(dx, dy);
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }

  function evaluate(input) {
    var value = (0, eval)(input.expression);
    var settle = function (result) {
      if (input.returnByValue === false) return { value: null };
      var text;
      try { text = JSON.stringify(result === undefined ? null : result); }
      catch (error) { text = JSON.stringify(String(result)); }
      if (text.length > LIMITS.evaluateResultChars) throw fail("PreviewAutomationResultTooLargeError", "The result is larger than " + LIMITS.evaluateResultChars + " characters.");
      return { value: JSON.parse(text) };
    };
    if (input.awaitPromise !== false && value && typeof value.then === "function") return value.then(settle);
    return settle(value);
  }

  function matches(input) {
    if (input.urlIncludes && location.href.indexOf(input.urlIncludes) < 0) return false;
    if (input.text && ((document.body && document.body.innerText) || "").indexOf(input.text) < 0) return false;
    if ((input.locator || input.selector) && !resolveTarget(input, false)) return false;
    return true;
  }
  function waitFor(input) {
    var deadline = Date.now() + (input.timeoutMs || 15000);
    return new Promise(function (resolve, reject) {
      (function check() {
        var ok;
        try { ok = matches(input); } catch (error) { reject(error); return; }
        if (ok) { resolve({ matched: true }); return; }
        if (Date.now() >= deadline) { reject(fail("PreviewAutomationTimeoutError", "The page did not match within " + (input.timeoutMs || 15000) + "ms.")); return; }
        setTimeout(check, 100);
      })();
    });
  }

  var operations = { snapshot: snapshot, click: click, type: type, press: press, scroll: scroll, evaluate: evaluate, waitFor: waitFor };
  window.__cwPageAgent = {
    run: function (id, operation, input) {
      var reply = function (value) { post({ type: MESSAGE_TYPE, id: id, ok: true, value: value }); };
      var refuse = function (error) {
        post({ type: MESSAGE_TYPE, id: id, ok: false, error: { tag: (error && error.cwTag) || "PreviewAutomationExecutionError", message: String((error && error.message) || error) } });
      };
      try {
        var handler = operations[operation];
        if (!handler) throw fail("PreviewAutomationUnsupportedOperationError", "This browser cannot run " + operation + ".");
        Promise.resolve(handler(input || {})).then(reply, refuse);
      } catch (error) {
        refuse(error);
      }
      return true;
    }
  };
  return true;
})();`;
}

/**
 * Installs Playwright's injected selector engine from its source, with the options the desktop
 * uses, so the page agent resolves locators the same way on both hosts. Does nothing when present.
 */
export function previewPlaywrightInstallScript(source: string): string {
  const options = JSON.stringify({
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  });
  return `(function () {
  if (globalThis.__t3PlaywrightInjected) return true;
  try {
    var module = { exports: {} };
    ${source}
    globalThis.__t3PlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${options});
  } catch (error) {}
  return true;
})();`;
}

/** The call the host injects to run one command; the reply arrives through `postMessage`. */
export function previewPageAgentCall(id: string, operation: string, input: unknown): string {
  return `(function(){try{${previewPageAgentScript()};window.__cwPageAgent.run(${JSON.stringify(id)},${JSON.stringify(operation)},${JSON.stringify(input ?? {})});}catch(error){(window.ReactNativeWebView||{postMessage:function(){}}).postMessage(JSON.stringify({type:${JSON.stringify(PREVIEW_PAGE_AGENT_MESSAGE_TYPE)},id:${JSON.stringify(id)},ok:false,error:{tag:"PreviewAutomationExecutionError",message:String(error&&error.message||error)}}));}})();true;`;
}
