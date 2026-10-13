// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercises the real loopback listener.
import { describe, expect, it } from "vite-plus/test";

import { receiveAccountCallback } from "./AccountLoopback.ts";

const STATE = "expected-state";

/** An `openBrowser` that plays the provider: calls the redirect URI with the given query. */
function browserThatRedirects(...queries: ReadonlyArray<string>) {
  const statuses: number[] = [];
  const authorizationUrls: string[] = [];
  return {
    statuses,
    authorizationUrls,
    openBrowser: async (url: string) => {
      authorizationUrls.push(url);
      const redirectUri = new URL(url).searchParams.get("redirect_uri")!;
      for (const query of queries) {
        statuses.push((await fetch(`${redirectUri}${query}`)).status);
      }
      return true;
    },
  };
}

const authorizationUrl = (redirectUri: string) =>
  `https://login.example.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}`;

describe("receiveAccountCallback", () => {
  it("resolves with the code from a redirect on a random loopback port", async () => {
    const browser = browserThatRedirects(`?code=abc&state=${STATE}`);

    const outcome = await receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      openBrowser: browser.openBrowser,
    });

    expect(outcome.status).toBe("code");
    if (outcome.status !== "code") return;
    expect(outcome.code).toBe("abc");
    expect(outcome.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(browser.statuses).toEqual([200]);
  });

  it("ignores requests with the wrong state or path and keeps waiting for the real one", async () => {
    const browser = browserThatRedirects("?code=evil&state=forged", `?code=real&state=${STATE}`);

    const outcome = await receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      openBrowser: async (url) => {
        const redirectUri = new URL(new URL(url).searchParams.get("redirect_uri")!);
        const stray = await fetch(`${redirectUri.origin}/favicon.ico`);
        browser.statuses.push(stray.status);
        return browser.openBrowser(url);
      },
    });

    expect(outcome).toMatchObject({ status: "code", code: "real" });
    expect(browser.statuses).toEqual([404, 400, 200]);
  });

  it("reports a denied sign-in", async () => {
    const browser = browserThatRedirects("?error=access_denied");
    const outcome = await receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      openBrowser: browser.openBrowser,
    });
    expect(outcome).toEqual({ status: "denied" });
  });

  it("fails when the browser cannot be opened", async () => {
    const outcome = await receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      openBrowser: async () => false,
    });
    expect(outcome).toEqual({ status: "failed" });
  });

  it("cancels when aborted and times out when nothing arrives", async () => {
    const controller = new AbortController();
    const cancelled = receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      signal: controller.signal,
      openBrowser: async () => {
        controller.abort();
        return true;
      },
    });
    expect(await cancelled).toEqual({ status: "cancelled" });

    const timedOut = await receiveAccountCallback({
      authorizationUrl,
      expectedState: STATE,
      timeoutMs: 20,
      openBrowser: async () => true,
    });
    expect(timedOut).toEqual({ status: "timed_out" });
  });
});
