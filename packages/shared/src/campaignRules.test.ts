import type { CampaignPost, CampaignPostStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  LOCAL_GPU_DEFAULT_VIDEO_PRESET,
  LOCAL_GPU_VIDEO_PRESETS,
  approvedByLabel,
  checkGenerationSpend,
  estimateGenerationUsd,
  generationUsedUsd,
  isValidLocalGpuWindow,
  localGpuBusyNote,
  localGpuWaitExpired,
  localGpuWindowNote,
  localGpuWindowOpen,
  type GenerationSpendJob,
  canTransition,
  captionFor,
  duePosts,
  effectiveMode,
  findDoNotSay,
  nextStatusAfterSubmit,
  statusAfterEdit,
  statusAfterPersonApproval,
  validateCampaignPost,
} from "./campaignRules.ts";

const STATUSES: ReadonlyArray<CampaignPostStatus> = [
  "draft",
  "needs-approval",
  "approved",
  "scheduled",
  "publishing",
  "posted",
  "failed",
  "rejected",
];
const NOW = "2026-10-06T12:00:00.000Z";

const post = (overrides: Partial<CampaignPost> = {}): CampaignPost => ({
  id: "p1",
  campaignId: "c1",
  status: "draft",
  platforms: ["facebook"],
  captions: { default: "Hello", byPlatform: {} },
  mediaPaths: [],
  mediaUrls: [],
  uploadedMedia: {},
  createdBy: { kind: "person" },
  approval: null,
  publishResults: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("effectiveMode", () => {
  it("uses the campaign's mode when it has one, else the client's", () => {
    expect(effectiveMode({ approvalMode: "ask-first" }, {})).toBe("ask-first");
    expect(effectiveMode({ approvalMode: "auto-publish" }, { approvalMode: "ask-first" })).toBe(
      "ask-first",
    );
    expect(effectiveMode({ approvalMode: "ask-first" }, { approvalMode: "report-when-done" })).toBe(
      "report-when-done",
    );
  });
});

describe("nextStatusAfterSubmit", () => {
  it("waits for a person under ask-first, even with a time that has passed", () => {
    expect(nextStatusAfterSubmit("ask-first", { now: NOW })).toEqual({
      status: "needs-approval",
      approval: null,
    });
    expect(
      nextStatusAfterSubmit("ask-first", { now: NOW, scheduledAt: "2026-10-01T00:00:00.000Z" })
        .status,
    ).toBe("needs-approval");
  });

  it("approves by the mode, naming it, in the other two modes", () => {
    for (const mode of ["report-when-done", "auto-publish"] as const) {
      expect(nextStatusAfterSubmit(mode, { now: NOW })).toEqual({
        status: "approved",
        approval: { by: "mode", mode, at: NOW },
      });
    }
  });

  it("schedules when the proposed time is ahead and not otherwise", () => {
    expect(
      nextStatusAfterSubmit("auto-publish", { now: NOW, scheduledAt: "2026-10-07T09:00:00.000Z" })
        .status,
    ).toBe("scheduled");
    expect(
      nextStatusAfterSubmit("auto-publish", { now: NOW, scheduledAt: "2026-10-05T09:00:00.000Z" })
        .status,
    ).toBe("approved");
    expect(
      nextStatusAfterSubmit("auto-publish", { now: NOW, scheduledAt: "not a date" }).status,
    ).toBe("approved");
  });
});

describe("statusAfterPersonApproval", () => {
  it("is scheduled only for a future time", () => {
    expect(statusAfterPersonApproval({ now: NOW })).toBe("approved");
    expect(statusAfterPersonApproval({ now: NOW, scheduledAt: "2026-10-07T00:00:00.000Z" })).toBe(
      "scheduled",
    );
  });
});

describe("canTransition", () => {
  it("never lets an agent approve, schedule, publish or reject", () => {
    for (const from of STATUSES) {
      for (const to of ["approved", "scheduled", "publishing", "posted", "rejected"] as const) {
        expect(canTransition(from, to, "agent")).toBe(false);
      }
    }
  });

  it("gives an agent no route to approved under ask-first, however many steps it takes", () => {
    const reachable = new Set<CampaignPostStatus>(["draft"]);
    const queue: CampaignPostStatus[] = ["draft"];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const to of STATUSES) {
        if (canTransition(from, to, "agent") && !reachable.has(to)) {
          reachable.add(to);
          queue.push(to);
        }
      }
    }
    // The only status an agent's own submit can produce under ask-first is needs-approval.
    expect(nextStatusAfterSubmit("ask-first", { now: NOW }).status).toBe("needs-approval");
    expect([...reachable].toSorted()).toEqual(["draft", "needs-approval"]);
  });

  it("lets an agent submit a draft and take a submission back, and nothing else", () => {
    expect(canTransition("draft", "needs-approval", "agent")).toBe(true);
    expect(canTransition("needs-approval", "draft", "agent")).toBe(true);
    expect(canTransition("approved", "draft", "agent")).toBe(false);
    expect(canTransition("failed", "draft", "agent")).toBe(false);
  });

  it("lets a person approve, reject, request changes, publish now and retry", () => {
    expect(canTransition("needs-approval", "approved", "person")).toBe(true);
    expect(canTransition("needs-approval", "scheduled", "person")).toBe(true);
    expect(canTransition("needs-approval", "rejected", "person")).toBe(true);
    expect(canTransition("needs-approval", "draft", "person")).toBe(true);
    expect(canTransition("scheduled", "approved", "person")).toBe(true);
    expect(canTransition("failed", "approved", "person")).toBe(true);
    expect(canTransition("rejected", "draft", "person")).toBe(true);
  });

  it("never lets a person touch a post that is publishing or posted", () => {
    for (const from of ["publishing", "posted"] as const) {
      for (const to of STATUSES) expect(canTransition(from, to, "person")).toBe(false);
    }
  });

  it("lets only the system move a post through publishing", () => {
    expect(canTransition("approved", "publishing", "system")).toBe(true);
    expect(canTransition("scheduled", "publishing", "system")).toBe(true);
    expect(canTransition("publishing", "posted", "system")).toBe(true);
    expect(canTransition("publishing", "failed", "system")).toBe(true);
    for (const from of STATUSES) {
      expect(canTransition(from, "publishing", "person")).toBe(false);
      expect(canTransition(from, "publishing", "agent")).toBe(false);
    }
    expect(canTransition("draft", "publishing", "system")).toBe(false);
    expect(canTransition("needs-approval", "approved", "system")).toBe(false);
    expect(canTransition("failed", "posted", "system")).toBe(false);
  });
});

describe("statusAfterEdit", () => {
  it("drops an edited post back to draft", () => {
    expect(statusAfterEdit("draft", "agent")).toBe("draft");
    expect(statusAfterEdit("needs-approval", "agent")).toBe("draft");
    expect(statusAfterEdit("approved", "person")).toBe("draft");
    expect(statusAfterEdit("failed", "person")).toBe("draft");
  });

  it("refuses edits an actor may not make", () => {
    expect(statusAfterEdit("approved", "agent")).toBeNull();
    expect(statusAfterEdit("scheduled", "agent")).toBeNull();
    expect(statusAfterEdit("posted", "person")).toBeNull();
    expect(statusAfterEdit("publishing", "person")).toBeNull();
  });
});

describe("duePosts", () => {
  it("takes approved and scheduled posts whose time has come", () => {
    const posts = [
      post({ id: "a", status: "approved" }),
      post({ id: "b", status: "scheduled", scheduledAt: "2026-10-06T11:00:00.000Z" }),
      post({ id: "c", status: "scheduled", scheduledAt: "2026-10-06T13:00:00.000Z" }),
      post({ id: "d", status: "needs-approval" }),
      post({ id: "e", status: "draft", scheduledAt: "2026-10-01T00:00:00.000Z" }),
      post({ id: "f", status: "publishing" }),
      post({ id: "g", status: "approved", scheduledAt: NOW }),
    ];
    expect(duePosts(posts, NOW).map((entry) => entry.id)).toEqual(["a", "b", "g"]);
  });

  it("returns nothing when the clock reading is not a date", () => {
    expect(duePosts([post({ status: "approved" })], "nope")).toEqual([]);
  });
});

describe("captionFor", () => {
  it("prefers the platform's own caption and falls back to the default", () => {
    const value = post({
      captions: { default: "Default", byPlatform: { instagram: "IG", tiktok: "  " } },
    });
    expect(captionFor(value, "instagram")).toBe("IG");
    expect(captionFor(value, "tiktok")).toBe("Default");
    expect(captionFor(value, "facebook")).toBe("Default");
  });
});

describe("findDoNotSay", () => {
  it("matches phrases ignoring case and skips blank entries", () => {
    expect(findDoNotSay("Our CHEAPEST package", ["cheapest", " ", "free"])).toEqual(["cheapest"]);
  });
});

describe("validateCampaignPost", () => {
  it("accepts a plain text post for a platform that needs no media", () => {
    expect(validateCampaignPost(post())).toEqual([]);
  });

  it("needs at least one platform", () => {
    expect(validateCampaignPost(post({ platforms: [] }))).toContain(
      "Choose at least one platform.",
    );
  });

  it("needs a caption for every platform it names", () => {
    const issues = validateCampaignPost(
      post({
        platforms: ["facebook", "linkedin"],
        captions: { default: "", byPlatform: { facebook: "Hi" } },
      }),
    );
    expect(issues).toEqual(["Write a caption for linkedin."]);
  });

  it("needs media for instagram, tiktok, youtube and pinterest, from a path or a link", () => {
    for (const platform of ["instagram", "tiktok", "youtube"] as const) {
      expect(validateCampaignPost(post({ platforms: [platform] }))).toEqual([
        `${platform} needs at least one image or video.`,
      ]);
      expect(validateCampaignPost(post({ platforms: [platform], mediaPaths: ["a.mp4"] }))).toEqual(
        [],
      );
      expect(
        validateCampaignPost(post({ platforms: [platform], mediaUrls: ["https://x.test/a.mp4"] })),
      ).toEqual([]);
    }
    for (const platform of ["facebook", "linkedin", "gbp"] as const) {
      expect(validateCampaignPost(post({ platforms: [platform] }))).toEqual([]);
    }
  });

  it("holds Pinterest to a title of at most 100 characters and a destination link", () => {
    const base = { platforms: ["pinterest" as const], mediaUrls: ["https://x.test/a.png"] };
    expect(validateCampaignPost(post(base))).toEqual([
      "Pinterest needs a title.",
      "Pinterest needs a destination link.",
    ]);
    expect(
      validateCampaignPost(
        post({ ...base, title: "T".repeat(101), destinationUrl: "https://x.test" }),
      ),
    ).toEqual(["The Pinterest title is longer than 100 characters."]);
    expect(
      validateCampaignPost(
        post({ ...base, title: "T".repeat(100), destinationUrl: "https://x.test" }),
      ),
    ).toEqual([]);
    expect(
      validateCampaignPost(post({ ...base, title: "T", destinationUrl: "javascript:alert(1)" })),
    ).toEqual(["The Pinterest destination link is not a web address."]);
  });

  it("flags the client's do-not-say phrases and an unreadable time", () => {
    const issues = validateCampaignPost(
      post({ captions: { default: "Best price ever", byPlatform: {} }, scheduledAt: "soon" }),
      { doNotSay: ["best price"] },
    );
    expect(issues).toEqual([
      "The proposed time is not a valid date and time.",
      'The facebook caption says "best price", which is on this client\'s do-not-say list.',
    ]);
  });
});

describe("approvedByLabel", () => {
  it("names a person or the mode that approved", () => {
    expect(approvedByLabel(null)).toBe("none");
    expect(approvedByLabel({ by: "person", at: NOW })).toBe("person");
    expect(approvedByLabel({ by: "mode", mode: "auto-publish", at: NOW })).toBe(
      "mode:auto-publish",
    );
  });
});

describe("generation spend", () => {
  const NOW = "2026-10-15T12:00:00.000Z";
  const job = (overrides: Partial<GenerationSpendJob> = {}): GenerationSpendJob => ({
    status: "done",
    estimatedUsd: 2,
    createdAt: "2026-10-02T00:00:00.000Z",
    started: true,
    ...overrides,
  });

  it("adds this month's queued, running, done and started-then-cancelled jobs only", () => {
    const used = generationUsedUsd(
      [
        job(),
        job({ status: "queued", estimatedUsd: 1.5 }),
        job({ status: "running", estimatedUsd: 0.25 }),
        job({ status: "failed", estimatedUsd: 100 }),
        job({ status: "needs-approval", estimatedUsd: 100 }),
        job({ status: "cancelled", started: false, estimatedUsd: 100 }),
        job({ status: "cancelled", started: true, estimatedUsd: 1 }),
        job({ createdAt: "2026-09-30T23:59:59.000Z", estimatedUsd: 100 }),
        job({ estimatedUsd: null }),
      ],
      NOW,
    );
    expect(used).toBe(4.75);
  });

  it("refuses a job that would pass the limit and names the client and the amounts", () => {
    expect(
      checkGenerationSpend({
        clientName: "Candid Studios",
        capUsd: 10,
        usedUsd: 8,
        estimatedUsd: 2.5,
      }),
    ).toEqual({
      ok: false,
      message: "This would pass Candid Studios's monthly limit of $10.00 ($8.00 used).",
    });
  });

  it("allows a job that lands exactly on the limit, and any job when there is no limit", () => {
    expect(
      checkGenerationSpend({ clientName: "A", capUsd: 10, usedUsd: 8, estimatedUsd: 2 }),
    ).toEqual({ ok: true, note: null });
    expect(
      checkGenerationSpend({ clientName: "A", capUsd: undefined, usedUsd: 999, estimatedUsd: 50 }),
    ).toEqual({ ok: true, note: null });
  });

  it("counts an unknown cost as $0 and says so", () => {
    const decision = checkGenerationSpend({
      clientName: "A",
      capUsd: 10,
      usedUsd: 10,
      estimatedUsd: null,
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.note).toMatch(/counts as \$0/);
  });

  it("states a cost only where a price is known", () => {
    expect(
      estimateGenerationUsd({
        connector: "openrouter",
        kind: "video",
        model: "bytedance/seedance-2.0",
        durationSeconds: 5,
      }).usd,
    ).toBeNull();
    expect(estimateGenerationUsd({ connector: "local", kind: "image", model: "x" }).usd).toBe(0);
    expect(
      estimateGenerationUsd({ connector: "fal", kind: "video", model: "fal-ai/veo3.1" }),
    ).toEqual({
      usd: null,
      note: "fal.ai charges per second of video; see the model's page for its rate.",
    });
  });
});

describe("local graphics card window", () => {
  const at = (hour: number, minute = 0) => hour * 60 + minute;
  const night = { start: "22:00", end: "06:00" };

  it("is open at any time when both times are empty or unreadable", () => {
    expect(localGpuWindowOpen({ start: "", end: "", minuteOfDay: at(13) })).toBe(true);
    expect(localGpuWindowOpen({ start: "22:00", end: "", minuteOfDay: at(13) })).toBe(true);
    expect(localGpuWindowOpen({ start: "late", end: "06:00", minuteOfDay: at(13) })).toBe(true);
    expect(localGpuWindowOpen({ start: "08:00", end: "08:00", minuteOfDay: at(13) })).toBe(true);
    expect(localGpuWindowNote({ start: "", end: "", minuteOfDay: at(13) })).toBeNull();
  });

  it("handles a window inside one day", () => {
    const day = { start: "01:00", end: "05:00" };
    expect(localGpuWindowOpen({ ...day, minuteOfDay: at(0, 59) })).toBe(false);
    expect(localGpuWindowOpen({ ...day, minuteOfDay: at(1) })).toBe(true);
    expect(localGpuWindowOpen({ ...day, minuteOfDay: at(4, 59) })).toBe(true);
    expect(localGpuWindowOpen({ ...day, minuteOfDay: at(5) })).toBe(false);
  });

  it("handles a window that crosses midnight", () => {
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(21, 59) })).toBe(false);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(22) })).toBe(true);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(23, 59) })).toBe(true);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(0) })).toBe(true);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(5, 59) })).toBe(true);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(6) })).toBe(false);
    expect(localGpuWindowOpen({ ...night, minuteOfDay: at(12) })).toBe(false);
  });

  it("says when the job will be allowed to start", () => {
    expect(localGpuWindowNote({ ...night, minuteOfDay: at(12) })).toBe(
      "Scheduled for tonight after 22:00.",
    );
    expect(localGpuWindowNote({ ...night, minuteOfDay: at(23) })).toBeNull();
  });

  it("accepts both empty or two clock times, nothing else", () => {
    expect(isValidLocalGpuWindow("", "")).toBe(true);
    expect(isValidLocalGpuWindow("22:00", "06:00")).toBe(true);
    expect(isValidLocalGpuWindow("22:00", "")).toBe(false);
    expect(isValidLocalGpuWindow("24:00", "06:00")).toBe(false);
    expect(isValidLocalGpuWindow("9:00", "06:00")).toBe(false);
  });

  it("words the busy note and gives up after a day", () => {
    expect(localGpuBusyNote(3.28, 6.5)).toBe(
      "Waiting for the graphics card: 3.3 GB free, this model needs 6.5 GB.",
    );
    const since = "2026-10-07T01:00:00.000Z";
    expect(localGpuWaitExpired(since, "2026-10-08T00:59:59.000Z")).toBe(false);
    expect(localGpuWaitExpired(since, "2026-10-08T01:00:01.000Z")).toBe(true);
    expect(localGpuWaitExpired("not a date", "2026-10-08T01:00:01.000Z")).toBe(false);
  });
});

describe("local video presets", () => {
  it("lists each commercially licensed model once, with sane limits and a default that exists", () => {
    const ids = LOCAL_GPU_VIDEO_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(LOCAL_GPU_DEFAULT_VIDEO_PRESET);
    for (const preset of LOCAL_GPU_VIDEO_PRESETS) {
      expect(preset.license).toBe("Apache-2.0");
      expect(preset.minSeconds).toBeGreaterThan(0);
      expect(preset.maxSeconds).toBeGreaterThanOrEqual(preset.minSeconds);
      expect(preset.freeGb).toBeGreaterThan(0);
      expect(preset.pixelBudget % (32 * 32)).toBe(0);
    }
  });
});
