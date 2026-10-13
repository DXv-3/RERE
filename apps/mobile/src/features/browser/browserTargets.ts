import type { BrowserNavigationTarget } from "@t3tools/contracts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export class BrowserTargetUnreachableError extends Error {
  readonly cwTag = "PreviewAutomationUnavailableError";
}

/**
 * The address the phone's browser should load. The page runs on the phone, so "localhost" means
 * the machine CodeWrench runs on, which the phone reaches by that machine's own address. A server
 * the phone itself reaches only through loopback cannot be translated.
 */
export function resolveMobileBrowserUrl(
  target: BrowserNavigationTarget,
  environmentBaseUrl: string | null,
): string {
  const environmentHost = (() => {
    if (environmentBaseUrl === null) return null;
    try {
      return new URL(environmentBaseUrl).hostname;
    } catch {
      return null;
    }
  })();
  const reachableHost = () => {
    if (environmentHost === null || LOOPBACK_HOSTS.has(environmentHost)) {
      throw new BrowserTargetUnreachableError(
        "This phone cannot reach a dev server on the CodeWrench machine: the app is connected through an address that only works on that machine. Use a public URL, or connect the phone to the machine over Tailscale or the local network.",
      );
    }
    return environmentHost.includes(":") ? `[${environmentHost}]` : environmentHost;
  };
  if (target.kind === "environment-port") {
    const path = target.path ?? "/";
    return `${target.protocol ?? "http"}://${reachableHost()}:${target.port}${path.startsWith("/") ? path : `/${path}`}`;
  }
  const raw = target.url.trim();
  // "localhost:3000" also looks like a scheme, so only "x://" and about: count as one.
  const withScheme = /^([a-z][a-z0-9+.-]*:\/\/|about:)/i.test(raw)
    ? raw
    : `${/^(localhost|127\.|\[?::1\]?)/i.test(raw) ? "http" : "https"}://${raw}`;
  const url = new URL(withScheme);
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    url.hostname = reachableHost();
  }
  return url.toString();
}
