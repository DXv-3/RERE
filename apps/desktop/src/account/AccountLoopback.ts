// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Loopback receiver is a bounded Node listener with AbortSignal cleanup.
import * as NodeHttp from "node:http";

import { readAccountCallback } from "@t3tools/shared/accountAuth";

const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 300_000;

export type AccountCallbackOutcome =
  | { readonly status: "code"; readonly code: string; readonly redirectUri: string }
  | { readonly status: "denied" | "cancelled" | "timed_out" | "failed" };

const RESPONSE_PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>CodeWrench</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:90vh;margin:0}main{max-width:360px;padding:32px}h1{font-size:24px}p{line-height:1.6;opacity:.7}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

/**
 * Receives the sign-in provider's redirect on `http://127.0.0.1:<random port>/callback`, opens the
 * authorization page in the system browser, and resolves with the code once a redirect arrives
 * carrying the expected state. Requests that do not belong to this sign-in get a 400/404 and do not
 * end it, so a stray local request cannot cancel a sign-in in progress.
 */
export async function receiveAccountCallback(input: {
  readonly authorizationUrl: (redirectUri: string) => string;
  readonly expectedState: string;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<AccountCallbackOutcome> {
  const outcome = Promise.withResolvers<AccountCallbackOutcome>();
  let redirectUri = "";

  const server = NodeHttp.createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    if (incoming.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const callback = readAccountCallback(`${redirectUri}${url.search}`, input.expectedState);
    if (!callback.ok && callback.reason !== "denied") {
      response
        .writeHead(400, { "content-type": "text/html; charset=utf-8" })
        .end(
          RESPONSE_PAGE(
            "Sign-In Not Recognized",
            "This response does not belong to the active sign-in.",
          ),
        );
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        callback.ok
          ? RESPONSE_PAGE("Return to CodeWrench", "You are signed in. You can close this tab.")
          : RESPONSE_PAGE(
              "Sign-In Cancelled",
              "You can close this tab and try again in CodeWrench.",
            ),
      );
    outcome.resolve(
      callback.ok ? { status: "code", code: callback.code, redirectUri } : { status: "denied" },
    );
  });

  const timer = setTimeout(
    () => outcome.resolve({ status: "timed_out" }),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timer.unref();
  const cancel = () => outcome.resolve({ status: "cancelled" });
  input.signal?.addEventListener("abort", cancel, { once: true });

  try {
    if (input.signal?.aborted) return { status: "cancelled" };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") return { status: "failed" };
    redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    if (input.signal?.aborted) return { status: "cancelled" };
    if (!(await input.openBrowser(input.authorizationUrl(redirectUri))))
      return { status: "failed" };
    return await outcome.promise;
  } catch {
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
