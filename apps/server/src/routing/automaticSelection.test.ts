import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  adjustAdvice,
  chooseSelection,
  isWritingTask,
  localAdvice,
  type SelectionAdvice,
} from "./automaticSelection.ts";

const WRITING = [
  "write the download page",
  "update my résumé",
  "Update my resume for the Acme job",
  "Rewrite the landing page copy",
  "draft an email to the client about the delay",
  "tailor my cover letter to this job posting",
  "proofread the newsletter",
  "write up the case study",
  "Make the homepage headline better",
  "polish my bio",
  "write a blog post about our new API",
  "create an FAQ for the pricing page",
  "improve the product description",
  "write a message to the customer about the refund",
  "redo the about page",
  "fix the wording on the help article",
  "Update my CV with the new job",
  "write the press release",
  "draft the proposal for Acme",
  "edit the article",
  "fix the layout bug. Then write the home page",
  "write a job application answer about leadership",
];

const NOT_WRITING = [
  "write a test",
  "write a function",
  "write a test for the email sender",
  "write a unit test for the page",
  "update the page component's props",
  "fix the email validation regex",
  "create a report endpoint",
  "copy the file",
  "make a copy of the file",
  "the content-type header is wrong",
  "fix the commit message hook",
  "fix the layout of the landing page",
  "edit the post route",
  "fix the post request handler",
  "update the email schema migration",
  "write a script to export the report",
  "what does this page do?",
  "add a loading state to the upload button",
  "refactor the billing module",
  "",
];

describe("isWritingTask", () => {
  it.each(WRITING)("is true for %j", (task) => {
    expect(isWritingTask(task)).toBe(true);
  });
  it.each(NOT_WRITING)("is false for %j", (task) => {
    expect(isWritingTask(task)).toBe(false);
  });
});

const advice = (
  capability: SelectionAdvice["capability"],
  effort: SelectionAdvice["effort"],
  confidence = 0.9,
): SelectionAdvice => ({
  judge: "jev",
  capability,
  effort,
  capabilityConfidence: confidence,
  effortConfidence: confidence,
});

const FLOOR_NOTE = "writing for a reader is never turned down";

describe("the writing floor in adjustAdvice", () => {
  const writing = "write the download page";
  it("lifts basic and low to standard and medium, and says so", () => {
    const { advice: result, notes } = adjustAdvice(
      advice("basic", "low"),
      "balanced",
      null,
      writing,
    );
    expect(result).toMatchObject({ capability: "standard", effort: "medium" });
    expect(notes).toContain(FLOOR_NOTE);
  });

  it("holds against the saving preference and a weekly pace far ahead", () => {
    const pace = { usedPercent: 90, elapsedPercent: 20 };
    const { advice: result, notes } = adjustAdvice(
      advice("standard", "medium"),
      "save",
      pace,
      writing,
    );
    expect(result).toMatchObject({ capability: "standard", effort: "medium" });
    expect(notes).toContain(FLOOR_NOTE);
  });

  it("adds no note when it changed nothing", () => {
    const { advice: result, notes } = adjustAdvice(
      advice("advanced", "high"),
      "balanced",
      null,
      writing,
    );
    expect(result).toMatchObject({ capability: "advanced", effort: "high" });
    expect(notes).not.toContain(FLOOR_NOTE);
  });

  it("keeps an unsure judge's low confidence, so the model is still kept", () => {
    const { advice: result } = adjustAdvice(advice("basic", "low", 0.4), "balanced", null, writing);
    expect(result).toMatchObject({
      capability: "standard",
      effort: "medium",
      capabilityConfidence: 0.4,
    });
  });

  it("changes nothing outside writing tasks", () => {
    const { advice: result, notes } = adjustAdvice(
      advice("basic", "low"),
      "balanced",
      null,
      "what does this function do?",
    );
    expect(result).toMatchObject({ capability: "basic", effort: "low" });
    expect(notes).not.toContain(FLOOR_NOTE);
    const saved = adjustAdvice(
      advice("standard", "medium"),
      "save",
      null,
      "fix the email validation regex",
    );
    expect(saved.advice).toMatchObject({ capability: "standard", effort: "low" });
  });
});

describe("local rules and writing", () => {
  it("does not call a writing request basic or low", () => {
    for (const task of [
      "Can you proofread my cover letter?",
      "Is it ok to polish my bio?",
      "write the download page",
    ])
      expect(localAdvice(task, 0)).toMatchObject({ capability: "standard", effort: "medium" });
  });
  it("still calls a plain question basic", () => {
    expect(localAdvice("What does this function do?", 0)).toMatchObject({
      capability: "basic",
      effort: "low",
    });
  });
});

describe("a writing task on a thread at high effort", () => {
  const effort = {
    id: "effort",
    label: "Effort",
    type: "select" as const,
    options: ["low", "medium", "high"].map((id) => ({ id, label: id })),
  };
  const id = ProviderInstanceId.make("account-a");
  const provider = {
    instanceId: id,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: { optionDescriptors: [effort] },
    })),
  } as unknown as ServerProvider;
  const ladder = {
    basic: "claude-haiku-5",
    standard: "claude-sonnet-5",
    advanced: "claude-opus-5",
  };
  const current = {
    instanceId: id,
    model: "claude-sonnet-5",
    options: [{ id: "effort", value: "high" }],
  };

  const run = (
    preference: "save" | "balanced",
    pace: { usedPercent: number; elapsedPercent: number } | null,
    task: string,
  ) => {
    const adjusted = adjustAdvice(advice("basic", "low"), preference, pace, task);
    return chooseSelection({ provider, current, advice: adjusted.advice, ladder }).selection;
  };

  it("stays on its model and at high effort when the user prefers saving", () => {
    expect(run("save", null, "update my résumé")).toEqual(current);
  });
  it("stays on its model and at high effort when the weekly pace is far ahead", () => {
    expect(
      run("balanced", { usedPercent: 90, elapsedPercent: 20 }, "write the download page"),
    ).toEqual(current);
  });
  it("a simple non-writing task is still turned down as before", () => {
    expect(run("save", null, "what does this function do?")).toEqual({
      instanceId: id,
      model: "claude-haiku-5",
      options: [{ id: "effort", value: "low" }],
    });
  });
});
