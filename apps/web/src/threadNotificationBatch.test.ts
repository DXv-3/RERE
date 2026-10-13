import { describe, expect, it } from "vite-plus/test";

import {
  COMPLETION_BATCH_WINDOW_MS,
  completionBatchDescription,
  completionBatchTitle,
  recordCompletion,
} from "./threadNotificationBatch";

describe("recordCompletion", () => {
  it("starts a batch of one", () => {
    expect(recordCompletion(null, 1_000, "A")).toMatchObject({ count: 1, titles: ["A"] });
  });

  it("joins completions inside the window and starts over after it", () => {
    const first = recordCompletion(null, 0, "A");
    const second = recordCompletion(first, COMPLETION_BATCH_WINDOW_MS - 1, "B");
    expect(second).toBe(first);
    expect(second).toMatchObject({ count: 2, titles: ["A", "B"] });
    const later = recordCompletion(second, COMPLETION_BATCH_WINDOW_MS, "C");
    expect(later).not.toBe(first);
    expect(later).toMatchObject({ count: 1, titles: ["C"], startedAt: COMPLETION_BATCH_WINDOW_MS });
  });
});

describe("batch wording", () => {
  it("names the count and lists a few titles", () => {
    expect(completionBatchTitle(3)).toBe("3 threads finished");
    expect(completionBatchDescription(["A", "B"])).toBe("A, B");
    expect(completionBatchDescription(["A", "B", "C", "D", "E"])).toBe("A, B, C, and 2 more");
  });
});
