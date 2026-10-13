import { describe, expect, it } from "@effect/vitest";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { isCheckAccessDenied } from "./gitHubCheckAccess.ts";

const failure = (stderrExcerpt?: string) =>
  new GitHubCli.GitHubCliCommandError({
    command: "gh",
    cwd: "/w",
    cause: new Error("exit 1"),
    ...(stderrExcerpt === undefined ? {} : { stderrExcerpt }),
  });

describe("isCheckAccessDenied", () => {
  it.each([
    "GraphQL: Resource not accessible by personal access token (repository.pullRequest)",
    "HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)",
    "HTTP 403: Forbidden (https://api.github.com/repos/o/r/commits/abc/check-runs)",
    "HTTP 403: Forbidden (https://api.github.com/repos/o/r/actions/runs)",
  ])("recognises a refusal to show checks: %s", (said) => {
    expect(isCheckAccessDenied(failure(said))).toBe(true);
  });

  it.each([
    undefined,
    "error connecting to api.github.com",
    "HTTP 403: Forbidden (https://api.github.com/repos/o/r/pulls/7)",
    "HTTP 404: Not Found (https://api.github.com/repos/o/r/commits/abc/check-runs)",
  ])("leaves every other failure alone: %s", (said) => {
    expect(isCheckAccessDenied(failure(said))).toBe(false);
  });

  it("only ever applies to a failed command", () => {
    expect(
      isCheckAccessDenied(
        new GitHubCli.GitHubCliAuthenticationError({
          command: "gh",
          cwd: "/w",
          cause: new Error("not signed in"),
        }),
      ),
    ).toBe(false);
  });
});
