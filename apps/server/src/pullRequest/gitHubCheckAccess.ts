import type { GitHubPullRequestCliError } from "./GitHubPullRequestCli.ts";

/**
 * `gh` refused part of a pull request read the way GitHub refuses a token that lacks a
 * permission: "Resource not accessible by personal access token" (a fine-grained token without
 * the checks permission) or "by integration" (an app installation), or a bare 403 naming the
 * check-run, status or Actions endpoints. A rate limit, a missing pull request and a signed-out
 * `gh` are classified before they get here, so this only ever says "this credential may not see
 * that part".
 */
export function isCheckAccessDenied(error: GitHubPullRequestCliError): boolean {
  if (error._tag !== "GitHubCliCommandError") return false;
  const said = error.stderrExcerpt;
  if (said === undefined) return false;
  return (
    /resource not accessible by (?:personal access token|integration)/iu.test(said) ||
    (/\b403\b/u.test(said) && /check-runs|check_runs|statuses|\/status\b|actions\//iu.test(said))
  );
}
