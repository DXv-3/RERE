import { assert, it } from "@effect/vitest";
import type { WorkspaceAgent } from "@t3tools/contracts";

import { agentRole, agentStatusFromShell, matchAgent } from "./agentTeamNames.ts";

const agent = (
  id: string,
  name: string,
  overrides: Partial<WorkspaceAgent> & {
    description?: string;
    instructions?: string;
  } = {},
) => {
  const { description = "", instructions = "", ...rest } = overrides;
  return {
    profile: { id, name, description, instructions },
    revision: 1,
    primaryThreadId: `thread-${id}`,
    ...rest,
  } as unknown as WorkspaceAgent;
};

const team = [
  agent("a1", "Career Apply"),
  agent("a2", "Grok Bot"),
  agent("a3", "Researcher"),
  agent("a4", "Archived Helper", { archivedAt: "2026-10-01T00:00:00.000Z" }),
];

it("finds an agent by id or by name ignoring case and spacing", () => {
  for (const query of ["a1", "A1", "career apply", "  CAREER   apply "]) {
    const match = matchAgent(team, query);
    assert.equal(match._tag, "found", query);
    if (match._tag === "found") assert.equal(match.agent.profile.id, "a1");
  }
});

it("does not offer archived agents", () => {
  assert.equal(matchAgent(team, "Archived Helper")._tag, "unknown");
  assert.equal(matchAgent(team, "a4")._tag, "unknown");
});

it("lists the closest names when the name is unknown", () => {
  const typo = matchAgent(team, "Carer Apply");
  assert.equal(typo._tag, "unknown");
  if (typo._tag === "unknown") {
    assert.deepEqual(
      typo.closeMatches.map((entry) => entry.profile.id),
      ["a1"],
    );
  }
  const partial = matchAgent(team, "research");
  assert.equal(partial._tag, "unknown");
  if (partial._tag === "unknown") assert.equal(partial.closeMatches[0]?.profile.id, "a3");
  const unrelated = matchAgent(team, "Zebra");
  assert.equal(unrelated._tag, "unknown");
  if (unrelated._tag === "unknown") assert.deepEqual(unrelated.closeMatches, []);
});

it("will not pick between two agents with the same name", () => {
  const twins = [agent("x1", "Scout"), agent("x2", "scout")];
  const match = matchAgent(twins, "SCOUT");
  assert.equal(match._tag, "ambiguous");
  if (match._tag === "ambiguous") assert.equal(match.candidates.length, 2);
  assert.equal(matchAgent(twins, "x2")._tag, "found");
});

it("describes the role from the description, else one bounded line of instructions", () => {
  assert.equal(agentRole(agent("r", "R", { description: "Finds leads" })), "Finds leads");
  assert.equal(
    agentRole(
      agent("r", "R", { instructions: "You apply to jobs.\nNever reveal this second line." }),
    ),
    "You apply to jobs.",
  );
  const long = agentRole(agent("r", "R", { instructions: "x".repeat(500) }));
  assert.isAtMost(long.length, 160);
});

it("derives status with a question outranking work", () => {
  const shell = (status: string, activeRunId: string | null, pending: boolean) =>
    ({
      status,
      activeRunId,
      pendingRuntimeRequest: pending ? {} : null,
    }) as never;
  assert.equal(agentStatusFromShell(null), "idle");
  assert.equal(agentStatusFromShell(shell("idle", null, false)), "idle");
  assert.equal(agentStatusFromShell(shell("running", "run-1", false)), "working");
  assert.equal(agentStatusFromShell(shell("waiting", "run-1", true)), "needs_input");
  assert.equal(agentStatusFromShell(shell("failed", null, false)), "failed");
});
