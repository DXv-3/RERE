import { expect, it } from "vite-plus/test";
import {
  ACCURATE_MODEL,
  describeModelFile,
  modelDirectories,
  pickBestModel,
} from "./dictationModels.ts";

const pick = (...files: string[]) => pickBestModel(files.map((file) => ({ file })))?.file ?? null;

it("prefers the most accurate installed model", () => {
  const order = [
    "ggml-large-v3-turbo.bin",
    "ggml-large-v3-turbo-q8_0.bin",
    "ggml-large-v3-turbo-q5_0.bin",
    "ggml-large-v3.bin",
    "ggml-medium.en.bin",
    "ggml-medium.bin",
    "ggml-small.en.bin",
    "ggml-small.bin",
    "ggml-base.en.bin",
    "ggml-base.bin",
    "ggml-tiny.en.bin",
    "ggml-tiny.bin",
  ];
  for (let index = 0; index < order.length; index++) {
    // Any model beats everything listed after it, whatever order the directory lists them in.
    expect(pick(...order.slice(index).toReversed())).toBe(order[index]);
  }
});

it("ignores files that are not usable whisper models", () => {
  expect(
    pick("jfk.wav", "ggml-silero-v5.1.2.bin", "ggml-base.en.bin.part", "notes.txt"),
  ).toBeNull();
  expect(pick("ggml-large-v3-turbo-q5_0.bin.part", "ggml-tiny.bin")).toBe("ggml-tiny.bin");
});

it("names the model for the status line", () => {
  expect(describeModelFile("ggml-large-v3-turbo-q5_0.bin")?.label).toBe("Whisper Large v3 Turbo");
  expect(describeModelFile("ggml-base.en.bin")?.label).toBe("Whisper Base English");
  expect(describeModelFile("ggml-base.en-q5_1.bin")).toMatchObject({ english: true });
  expect(describeModelFile("ggml-small.bin")).toMatchObject({ english: false });
  expect(ACCURATE_MODEL.label).toBe(describeModelFile(ACCURATE_MODEL.file)?.label);
});

it("offers an upgrade only from small, base and tiny", () => {
  const upgrade = (file: string) => describeModelFile(file)?.worthUpgrading;
  expect(["ggml-tiny.bin", "ggml-base.en.bin", "ggml-small.bin"].map(upgrade)).toEqual([
    true,
    true,
    true,
  ]);
  expect(["ggml-medium.en.bin", "ggml-large-v3.bin", ACCURATE_MODEL.file].map(upgrade)).toEqual([
    false,
    false,
    false,
  ]);
});

it("searches the app's own folder first, then the usual places", () => {
  const join = (...parts: string[]) => parts.join("/");
  expect(modelDirectories({ home: "/h", userDataDirectory: "/data", join })).toEqual([
    "/data/whisper",
    "/h/Library/Application Support/CodeWrench/whisper",
    "/h/.local/share/whisper",
    "/h/.local/share/whisper-models",
    "/opt/homebrew/share/whisper-cpp",
    "/usr/local/share/whisper-cpp",
  ]);
  expect(modelDirectories({ home: "/h", join })).toHaveLength(5);
});

it("keeps the first copy when the same model is in two folders", () => {
  const found = pickBestModel([
    { file: "ggml-base.bin", path: "/data/whisper/ggml-base.bin" },
    { file: "ggml-base.bin", path: "/h/.local/share/whisper/ggml-base.bin" },
  ]);
  expect(found?.path).toBe("/data/whisper/ggml-base.bin");
});
