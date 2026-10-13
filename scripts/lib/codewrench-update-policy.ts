// Build-time opt-in only: ordinary previews must never inherit an upstream feed.
export function validateCodewrenchFeedUrl(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === "t3.codes" ||
    url.hostname.endsWith(".t3.codes") ||
    url.hostname === "github.com" ||
    url.hostname === "objects.githubusercontent.com" ||
    !url.pathname.startsWith("/codewrench/")
  ) {
    throw new Error(
      "CodeWrench updates require a dedicated HTTPS /codewrench/ feed without credentials, query, or fragment.",
    );
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

export function codewrenchPublishConfig(input: {
  feedUrl: string | undefined;
  platform: string;
  identity: string | undefined;
}) {
  if (!input.feedUrl?.trim()) return undefined;
  if (
    input.platform !== "mac" ||
    !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(input.identity?.trim() ?? "")
  ) {
    throw new Error(
      "CodeWrench updates require macOS and an explicit Developer ID Application signing identity.",
    );
  }
  return {
    provider: "generic" as const,
    url: validateCodewrenchFeedUrl(input.feedUrl.trim()),
    channel: "latest",
  };
}
