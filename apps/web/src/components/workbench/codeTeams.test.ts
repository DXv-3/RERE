import { expect, it } from "vite-plus/test";
import { describeTeam, memberPrompt, readTeams, worktreeBranch } from "./codeTeams";

it("reads a spoken sentence as a team, its task and whether to isolate", () => {
  expect(
    describeTeam("Start a builder and two reviewers on the login bug with separate worktrees."),
  ).toEqual({
    task: "The login bug",
    isolate: true,
    members: [
      { kind: "claude", role: "Builder", task: "" },
      { kind: "claude", role: "Reviewer", task: "" },
      { kind: "claude", role: "Reviewer", task: "" },
    ],
  });
  expect(describeTeam("launch 2 claude agents and a codex reviewer to refactor billing")).toEqual({
    task: "Refactor billing",
    isolate: false,
    members: [
      { kind: "claude", role: "", task: "" },
      { kind: "claude", role: "", task: "" },
      { kind: "codex", role: "Reviewer", task: "" },
    ],
  });
});

it("caps a described team at six and gives up when nobody is named", () => {
  expect(describeTeam("six builders and three testers: ship it")?.members).toHaveLength(6);
  expect(describeTeam("what is the weather")).toBeNull();
  expect(describeTeam("")).toBeNull();
});

it("gives a member its own task, or the shared one, led by its role", () => {
  expect(memberPrompt({ kind: "claude", role: "Reviewer", task: "" }, "Fix the login bug")).toBe(
    "Your role on this team: Reviewer. Fix the login bug",
  );
  expect(memberPrompt({ kind: "codex", role: "", task: "Write tests" }, "Fix the login bug")).toBe(
    "Write tests",
  );
  expect(memberPrompt({ kind: "claude", role: "Reviewer", task: " " }, " ")).toBe("");
});

it("names a worktree branch after the role and the pane", () => {
  expect(worktreeBranch("Front End / UI", "code-1234-abcdef")).toBe(
    "workbench/front-end-ui-abcdef",
  );
  expect(worktreeBranch("???", "code-1234-abcdef")).toBe("workbench/agent-abcdef");
});

it("keeps only well-formed saved teams", () => {
  const good = {
    name: "Build And Review",
    task: "Ship it",
    isolate: true,
    members: [{ kind: "claude", role: "Builder", task: "" }],
  };
  expect(
    readTeams([
      good,
      { ...good, members: [] },
      { ...good, members: [{ kind: "shell", role: "x", task: "" }] },
      { ...good, name: " " },
      "junk",
    ]),
  ).toEqual([good]);
});
