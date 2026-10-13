import { describe, expect, it } from "@effect/vitest";

import { BrowserTargetUnreachableError, resolveMobileBrowserUrl } from "./browserTargets";

describe("resolveMobileBrowserUrl", () => {
  const server = "http://100.64.0.7:3773";

  it("loads public sites as they are, adding https when no scheme is given", () => {
    expect(resolveMobileBrowserUrl({ kind: "url", url: "https://example.com/a" }, server)).toBe(
      "https://example.com/a",
    );
    expect(resolveMobileBrowserUrl({ kind: "url", url: "example.com" }, server)).toBe(
      "https://example.com/",
    );
  });

  it("points localhost and dev-server ports at the CodeWrench machine", () => {
    expect(resolveMobileBrowserUrl({ kind: "url", url: "http://localhost:5173/x" }, server)).toBe(
      "http://100.64.0.7:5173/x",
    );
    expect(resolveMobileBrowserUrl({ kind: "url", url: "localhost:3000" }, server)).toBe(
      "http://100.64.0.7:3000/",
    );
    expect(
      resolveMobileBrowserUrl({ kind: "environment-port", port: 5173, path: "settings" }, server),
    ).toBe("http://100.64.0.7:5173/settings");
  });

  it("says plainly when the machine is only reachable through loopback", () => {
    expect(() =>
      resolveMobileBrowserUrl({ kind: "environment-port", port: 5173 }, "http://127.0.0.1:3773"),
    ).toThrow(BrowserTargetUnreachableError);
    expect(() => resolveMobileBrowserUrl({ kind: "url", url: "http://localhost:1" }, null)).toThrow(
      BrowserTargetUnreachableError,
    );
  });
});
