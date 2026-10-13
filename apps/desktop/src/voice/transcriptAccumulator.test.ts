import { describe, expect, it } from "vite-plus/test";

import { createTranscriptAccumulator, isUtteranceRestart } from "./transcriptAccumulator.ts";

describe("createTranscriptAccumulator", () => {
  it("keeps what was said before a pause when the recognizer starts over", () => {
    const transcript = createTranscriptAccumulator();
    for (const report of [
      "Okay",
      "Okay this voice",
      "Okay this voice to text function is not working correctly.",
    ]) {
      transcript.update(report);
    }
    expect(transcript.update("Any")).toBe(
      "Okay this voice to text function is not working correctly. Any",
    );
    expect(transcript.update("Anytime I pause it overrides what I said.")).toBe(
      "Okay this voice to text function is not working correctly. Anytime I pause it overrides what I said.",
    );
    // A second pause keeps both earlier utterances.
    expect(transcript.update("So")).toBe(
      "Okay this voice to text function is not working correctly. Anytime I pause it overrides what I said. So",
    );
  });

  it("follows the recognizer when it rewrites words inside one utterance", () => {
    const transcript = createTranscriptAccumulator();
    transcript.update("Send the report to John");
    expect(transcript.update("Send the report to Jon tomorrow")).toBe(
      "Send the report to Jon tomorrow",
    );
    expect(transcript.update("Send the report to Jon")).toBe("Send the report to Jon");
  });

  it("ignores an empty report after speech and starts clean after a reset", () => {
    const transcript = createTranscriptAccumulator();
    transcript.update("Run the full test suite");
    expect(transcript.update("")).toBe("Run the full test suite");
    transcript.reset();
    expect(transcript.text()).toBe("");
    expect(transcript.update("Hello")).toBe("Hello");
  });
});

describe("isUtteranceRestart", () => {
  it("treats a sudden drop to a new opening as a restart", () => {
    expect(isUtteranceRestart("I went to the store today", "And")).toBe(true);
    expect(isUtteranceRestart("I went to the store today", "And then we")).toBe(true);
  });

  it("does not treat corrections or backing up as a restart", () => {
    expect(isUtteranceRestart("I scream", "Ice cream")).toBe(false);
    expect(isUtteranceRestart("I went to the store today", "I went to")).toBe(false);
    expect(isUtteranceRestart("I went to the store today", "I went to the shop today")).toBe(false);
    expect(isUtteranceRestart("", "Hello")).toBe(false);
  });
});
