import { describe, expect, it } from "@effect/vitest";

import { stderrExcerpt } from "./stderrExcerpt.ts";

describe("stderrExcerpt", () => {
  it("takes the first line that says something, and only that one", () => {
    expect(
      stderrExcerpt(
        [
          "",
          "warning: a newer release of gh is available",
          "GraphQL: Resource not accessible by personal access token (repository.pullRequest.commits)",
          "GraphQL: Resource not accessible by personal access token (repository.pullRequest.labels)",
        ].join("\n"),
      ),
    ).toBe(
      "GraphQL: Resource not accessible by personal access token (repository.pullRequest.commits)",
    );
  });

  it("is undefined when there is nothing to say", () => {
    expect(stderrExcerpt("")).toBeUndefined();
    expect(stderrExcerpt("  \r\n\n")).toBeUndefined();
  });

  it.each([
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789_abcdef",
    "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  ])("redacts GitHub tokens: %s", (token) => {
    const excerpt = stderrExcerpt(
      `HTTP 401: Bad credentials with ${token} (https://api.github.com/)`,
    );
    expect(excerpt).toContain("Bad credentials");
    expect(excerpt).not.toContain(token);
    expect(excerpt).not.toContain("11ABCDEFG0");
  });

  it("redacts bearer headers, key-value secrets and URL query strings", () => {
    const excerpt = stderrExcerpt(
      "request failed: Authorization: Bearer abc.def-123 token=hunter2 https://github.com/o/r?access_token=s3cret",
    );
    expect(excerpt).not.toContain("abc.def-123");
    expect(excerpt).not.toContain("hunter2");
    expect(excerpt).not.toContain("s3cret");
  });

  it("bounds the length", () => {
    const excerpt = stderrExcerpt(`GraphQL: ${"x".repeat(1_000)}`);
    expect(excerpt?.length).toBeLessThanOrEqual(241);
    expect(excerpt?.endsWith("…")).toBe(true);
  });
});
