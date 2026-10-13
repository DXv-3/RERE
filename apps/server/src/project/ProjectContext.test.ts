import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectMemoryDir, renderProjectContext } from "./ProjectContext.ts";

const base = {
  title: "Payments API",
  goal: null,
  instructions: null,
  memoryDir: "/state/project-memory/p1",
  memoryIndex: null,
};

describe("renderProjectContext", () => {
  it("sends nothing for a project with no goal, instructions or memory", () => {
    expect(renderProjectContext(base)).toBe("");
    expect(renderProjectContext({ ...base, goal: "  ", instructions: "\n" })).toBe("");
  });

  it("carries the goal, the instructions and where memory lives", () => {
    const context = renderProjectContext({
      ...base,
      goal: "Hold p95 under 200 ms",
      instructions: "Branch from main.\nOne draft pull request per thread.",
    });
    expect(context.startsWith("<project_context>\n")).toBe(true);
    expect(context.endsWith("\n</project_context>")).toBe(true);
    expect(context).toContain('project "Payments API"');
    expect(context).toContain("Project goal: Hold p95 under 200 ms");
    expect(context).toContain(
      "Project instructions:\nBranch from main.\nOne draft pull request per thread.",
    );
    expect(context).toContain(
      "files in /state/project-memory/p1. MEMORY.md there is the index:\n(empty)",
    );
  });

  it("includes a project whose only standing context is its memory index", () => {
    const context = renderProjectContext({ ...base, memoryIndex: "- deploys.md: how we ship" });
    expect(context).toContain("is the index:\n- deploys.md: how we ship");
    expect(context).not.toContain("Project goal:");
  });

  it("cuts a long memory index and says so", () => {
    const context = renderProjectContext({ ...base, memoryIndex: "x".repeat(9_000) });
    expect(context).toContain("[Index truncated; read the file for the rest.]");
    expect(context.length).toBeLessThan(5_000);
  });

  it("leaves memory out when the server has nowhere to keep it", () => {
    const context = renderProjectContext({ ...base, goal: "Ship it", memoryDir: null });
    expect(context).toContain("Project goal: Ship it");
    expect(context).not.toContain("Project memory");
  });
});

describe("the coordinator", () => {
  it("is told its role even in a project with no other standing context", () => {
    const context = renderProjectContext({ ...base, coordinator: true });
    expect(context).toContain("You are this project's coordinator.");
    expect(context).toContain("t3_thread_launch");
    expect(context).toContain("is the index:\n(empty)");
  });

  it("gets its role after the project's own goal and instructions", () => {
    const context = renderProjectContext({
      ...base,
      instructions: "Branch from develop.",
      coordinator: true,
    });
    expect(context.indexOf("Branch from develop.")).toBeLessThan(
      context.indexOf("You are this project's coordinator."),
    );
  });

  it("is not described to an ordinary thread", () => {
    expect(renderProjectContext({ ...base, goal: "Ship it" })).not.toContain("coordinator");
  });
});

describe("projectMemoryDir", () => {
  it("keeps the folder inside the state directory whatever the id holds", () => {
    expect(projectMemoryDir("/state", ProjectId.make("../../etc"))).toBe(
      "/state/project-memory/.._.._etc",
    );
  });
});
