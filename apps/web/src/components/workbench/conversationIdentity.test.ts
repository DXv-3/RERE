import { expect, it } from "vite-plus/test";
import {
  describeConversationEnvironment,
  describeConversationModel,
  isSameModel,
} from "./conversationIdentity";

it("marks the machine you are using as this device", () => {
  expect(
    describeConversationEnvironment({ label: "Ryan's Mac", isPrimary: true, connected: true }),
  ).toMatchObject({ text: "Ryan's Mac · This Device", tone: "this-device" });
  expect(
    describeConversationEnvironment({ label: " ", isPrimary: true, connected: true }).text,
  ).toBe("This Device");
});

it("shows a remote machine by its own name", () => {
  expect(
    describeConversationEnvironment({ label: "candid-server", isPrimary: false, connected: true }),
  ).toMatchObject({ text: "candid-server", tone: "remote" });
  expect(
    describeConversationEnvironment({ label: null, isPrimary: false, connected: true }).text,
  ).toBe("Unknown Machine");
});

it("says so when the machine is offline, whichever machine it is", () => {
  expect(
    describeConversationEnvironment({ label: "candid-server", isPrimary: false, connected: false }),
  ).toMatchObject({ text: "candid-server · Offline", tone: "offline" });
  expect(
    describeConversationEnvironment({ label: "Ryan's Mac", isPrimary: true, connected: false })
      .tone,
  ).toBe("offline");
});

it("names the provider instance and model, and falls back when either is missing", () => {
  expect(
    describeConversationModel({ providerName: "Local (Uncensored Qwen)", modelName: "Qwen3 30B" }),
  ).toEqual({
    text: "Local (Uncensored Qwen) · Qwen3 30B",
    title: "Selected model: Local (Uncensored Qwen) · Qwen3 30B",
    mismatch: false,
  });
  expect(describeConversationModel({ providerName: "Local (Free)", modelName: null }).text).toBe(
    "Local (Free)",
  );
  expect(describeConversationModel({ providerName: null, modelName: "" }).text).toBe(
    "No Model Selected",
  );
});

it("treats dated, prefixed and display forms of one model as the same", () => {
  expect(isSameModel("claude-opus-5-5", "claude-opus-5-5-20260601")).toBe(true);
  expect(isSameModel("Claude-Opus-5-5", "claude-opus-5-5")).toBe(true);
  expect(isSameModel("anthropic/claude-opus-5-5", "claude-opus-5-5")).toBe(true);
  expect(isSameModel("Claude Opus 5.5", "claude-opus-5-5-20260601")).toBe(true);
  expect(isSameModel("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false);
  expect(isSameModel("claude-opus-5-5", "claude-opus-4-6")).toBe(false);
  expect(isSameModel("", "claude-opus-5-5")).toBe(false);
  expect(isSameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true);
  expect(isSameModel("anthropic/claude-opus-5-5", "claude-opus-5-5-20260601")).toBe(true);
});

it("does not mistake a longer model name for a variant of a shorter one", () => {
  expect(isSameModel("gpt-5", "gpt-5-mini")).toBe(false);
  expect(isSameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
  expect(isSameModel("qwen3.8", "qwen3.6:35b-a3b")).toBe(false);
});

it("says who answered when the provider reports a different model than the selection", () => {
  const chip = describeConversationModel({
    providerName: "Claude",
    modelName: "Claude Opus 5.5",
    modelSlug: "claude-opus-5-5",
    answeringModel: "claude-haiku-4-5",
  });
  expect(chip.text).toBe("Answered By claude-haiku-4-5");
  expect(chip.mismatch).toBe(true);
  expect(chip.title).toContain("Claude · Claude Opus 5.5");
  expect(chip.title).toContain("claude-haiku-4-5");
});

it("keeps the selection when the answering model matches it or is not reported", () => {
  const selected = {
    providerName: "Claude",
    modelName: "Claude Opus 5.5",
    modelSlug: "claude-opus-5-5",
  };
  const unchanged = describeConversationModel(selected);
  expect(unchanged).toMatchObject({ text: "Claude · Claude Opus 5.5", mismatch: false });
  expect(
    describeConversationModel({ ...selected, answeringModel: "claude-opus-5-5-20260601" }),
  ).toEqual(unchanged);
  expect(describeConversationModel({ ...selected, answeringModel: null })).toEqual(unchanged);
  expect(describeConversationModel({ ...selected, answeringModel: "  " })).toEqual(unchanged);
  expect(
    describeConversationModel({ providerName: null, modelName: null, answeringModel: "x" })
      .mismatch,
  ).toBe(false);
});
