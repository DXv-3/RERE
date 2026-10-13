import { describe, expect, it } from "vite-plus/test";

import { formatModelShareCode } from "../components/settings/modelShareCode";
import {
  INITIAL_START_STATE,
  inspectShareCode,
  startReducer,
  type StartEvent,
  type StartState,
} from "./startChoice.logic";

const code = formatModelShareCode({
  baseUrl: "https://host.example/api/model-share",
  token: "token-123",
  models: ["claude-sonnet-5", "claude-haiku-5"],
});

const run = (events: ReadonlyArray<StartEvent>, from: StartState = INITIAL_START_STATE) =>
  events.reduce(startReducer, from);

describe("inspectShareCode", () => {
  it("is quiet for an empty field", () => {
    expect(inspectShareCode("  ")).toBeNull();
  });
  it("lists the model names a code carries", () => {
    expect(inspectShareCode(code)).toEqual({ models: ["claude-sonnet-5", "claude-haiku-5"] });
  });
  it("explains a code that cannot be used", () => {
    expect(inspectShareCode("hello")).toEqual({
      error: "That is not a share code. It starts with codewrench-share:",
    });
  });
});

describe("startReducer", () => {
  it("opens the paste screen from the choice and goes back to it", () => {
    const paste = run([{ type: "openShare" }]);
    expect(paste.phase).toBe("paste");
    expect(run([{ type: "edit", code }, { type: "back" }], paste)).toEqual(INITIAL_START_STATE);
  });

  it("does not move on a code it cannot read", () => {
    const state = run([{ type: "openShare" }, { type: "edit", code: "nope" }, { type: "submit" }]);
    expect(state.phase).toBe("paste");
    expect(state.error).toBe("That is not a share code. It starts with codewrench-share:");
  });

  it("asks for a code when the field is empty", () => {
    const state = run([{ type: "openShare" }, { type: "submit" }]);
    expect(state).toMatchObject({ phase: "paste", error: "Paste the share code you were sent." });
  });

  it("goes from a valid code to added, and drops the code once saved", () => {
    const state = run([{ type: "openShare" }, { type: "edit", code }, { type: "submit" }]);
    expect(state.phase).toBe("adding");
    expect(run([{ type: "succeeded", models: ["claude-sonnet-5"] }], state)).toEqual({
      phase: "added",
      code: "",
      error: null,
      addedModels: ["claude-sonnet-5"],
    });
  });

  it("returns to the paste screen with the reason when saving fails, keeping the code", () => {
    const adding = run([{ type: "openShare" }, { type: "edit", code }, { type: "submit" }]);
    expect(run([{ type: "failed", message: "Could not save." }], adding)).toMatchObject({
      phase: "paste",
      code,
      error: "Could not save.",
    });
  });

  it("clears the error as soon as the code is edited", () => {
    const failed = run([{ type: "openShare" }, { type: "edit", code: "x" }, { type: "submit" }]);
    expect(startReducer(failed, { type: "edit", code }).error).toBeNull();
  });

  it("ignores events that do not fit the current screen", () => {
    expect(run([{ type: "submit" }, { type: "succeeded", models: ["m"] }])).toEqual(
      INITIAL_START_STATE,
    );
    expect(run([{ type: "failed", message: "x" }])).toEqual(INITIAL_START_STATE);
  });
});
